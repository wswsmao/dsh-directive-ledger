/**
 * The directive ledger: a pure fold from the session log to the set of
 * standing user requirements that are in effect right now.
 *
 * Three decisions in this fold are load-bearing and are why it is written the
 * way it is:
 *
 * 1. It folds the WHOLE log, not the current surface. Compaction rewrites the
 *    surface, so a surface-derived ledger would silently drop every early rule.
 * 2. It still honours replacements. A `user/message` carrying
 *    `surfaceOp: {op:'replace'}` retires the directives whose source events it
 *    covers, so editing an old prompt (ask-again) removes its requirements
 *    instead of leaving them in force forever.
 * 3. Supersession is by topic key, not by time. "改成 B" must remove "用 A";
 *    otherwise both stay visible and the model picks the wrong one.
 *
 * @module directive-ledger/ledger
 */

import { extractDirectives } from './extract.js'

/** Projection key shared with the client half. */
export const PROJECTION_KEY = 'directiveLedger'

/**
 * Bumped whenever the fold's fields or semantics change.
 *
 * The extraction rules decide what a log folds into, so a change to them is a
 * change to this unit's meaning: the bumped version makes the durable
 * projection cache discard its stale rows and refold the whole log, instead of
 * serving requirements the current rules would no longer record.
 */
export const STATE_VERSION = 2

/** Ranking used for both prompt rendering and budget trimming. */
export const KIND_RANK = Object.freeze({ pin: 0, ban: 1, rule: 2, preference: 3, decision: 4 })

/** Statuses that still influence the model. */
export const IN_FORCE = Object.freeze(['active'])

/** An empty ledger state; also the fold's identity value. */
export function emptyState() {
  return { directives: {}, order: [], revision: 0, openTurn: 0 }
}

/** Whether one directive is currently in force. */
export function isActive(directive) {
  return directive !== undefined && directive.status === 'active'
}

/** Join the text blocks of one user message. */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
}

/** Whether a user message is the human speaking, not a subsystem notice. */
function isUserAuthored(message) {
  return message?.source?.kind === 'user'
}

/**
 * Deterministic ordering: kind rank, then source order. Two ledgers derived
 * from the same log therefore serialize to identical bytes, which is what
 * keeps the runtime-context snapshot from being rewritten every step.
 * @param {object} directive - candidate directive.
 * @returns {number} rank.
 */
function rankOf(directive) {
  return KIND_RANK[directive.kind] ?? 9
}

/**
 * Sort directives for presentation.
 * @param {object[]} directives - directives to sort.
 * @returns {object[]} a new sorted array.
 */
export function sortForDisplay(directives) {
  return [...directives].sort((left, right) => rankOf(left) - rankOf(right)
    || left.sourceSeq - right.sourceSeq
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/** Every directive in force, sorted, optionally filtered by topic. */
export function activeDirectives(state, topicKey) {
  const all = Object.values(state?.directives ?? {}).filter(isActive)
  const filtered = topicKey === undefined ? all : all.filter((directive) => directive.topicKey === topicKey)
  return sortForDisplay(filtered)
}

/**
 * Retire every other active directive on one topic.
 *
 * The ledger keeps exactly one live entry per topic, because two live entries
 * on the same subject is precisely the state that makes a model pick the stale
 * one. Every write path funnels through here so that invariant cannot drift.
 * @param {object} directives - directive map being built.
 * @param {string} topicKey - slot to clear.
 * @param {string} keepId - the directive that keeps the slot.
 */
function retireTopic(directives, topicKey, keepId) {
  const retired = []
  for (const directive of Object.values(directives)) {
    if (directive.id === keepId || directive.topicKey !== topicKey || !isActive(directive)) continue
    // A pin survives automatic replacement; only an explicit command displaces it.
    if (directive.kind === 'pin') continue
    directives[directive.id] = { ...directive, status: 'superseded', supersededBy: keepId }
    retired.push(directive.id)
  }
  return retired
}

/**
 * Insert one extracted candidate, superseding the directive that currently
 * holds the same topic slot.
 * @param {object} state - current ledger state (mutated copy in progress).
 * @param {object} seed - identity and provenance of the new directive.
 * @param {{text: string, kind: string, topicKey: string, checker?: object}} candidate - extracted requirement.
 * @returns {object} the next state.
 */
function insertCandidate(state, seed, candidate) {
  const id = seed.id
  // A pending entry can be re-inserted once its verdict arrives; anything the
  // user decided (or a real verdict) is final and must not be overwritten.
  const existing = state.directives[id]
  if (existing !== undefined && existing.judged !== 'rules') return state
  const directives = { ...state.directives }
  if (existing !== undefined) delete directives[id]
  const supersedes = retireTopic(directives, candidate.topicKey, id)
  // A pin blocks automatic replacement, so the slot may still be held. The new
  // statement is then recorded as already superseded — visible in `/rule list`,
  // never silently dropped — and the user resolves it with /rule pin or drop.
  const blocked = Object.values(directives).find((directive) => directive.topicKey === candidate.topicKey && isActive(directive))
  directives[id] = {
    id,
    sourceSeq: seed.sourceSeq,
    turn: seed.turn,
    quote: seed.quote,
    text: candidate.text,
    kind: candidate.kind,
    topicKey: candidate.topicKey,
    authority: seed.authority,
    status: blocked === undefined ? 'active' : 'superseded',
    supersedes,
    supersededBy: blocked?.id ?? null,
    checker: candidate.checker ?? null,
    judged: seed.judged ?? 'rules',
    reason: seed.reason ?? '',
  }
  const order = existing === undefined ? [...state.order, id] : state.order
  return { ...state, directives, order, revision: state.revision + 1 }
}

/** Parse `/rule` arguments into an operation. */
function parseRuleCommand(args) {
  const match = /^\s*([a-z]+)\s*(.*)$/i.exec(String(args ?? ''))
  if (match === null) return undefined
  const verb = match[1].toLowerCase()
  const rest = match[2].trim()
  if (!['list', 'why', 'pin', 'drop', 'add'].includes(verb)) return undefined
  return { verb, rest }
}

/** Resolve a `/rule` target that may be an id or a source sequence. */
function resolveTarget(state, rest) {
  if (rest === '') return undefined
  if (state.directives[rest] !== undefined) return rest
  const bySeq = String(rest).startsWith('#') ? Number(rest.slice(1)) : Number(rest)
  if (!Number.isSafeInteger(bySeq)) return undefined
  const found = Object.values(state.directives).find((directive) => directive.sourceSeq === bySeq && isActive(directive))
  return found?.id
}

/**
 * One committed event in, one ledger state out.
 * Pure and synchronous; returns the same reference for events it ignores.
 *
 * `resolve` supplies the semantic verdicts. The fold cannot await one — the host
 * folds projections synchronously over arbitrary log slices — so the judge runs
 * asynchronously elsewhere and this function only reads what has already landed:
 *
 * - a cached verdict decides the message outright;
 * - a message with no verdict yet falls back to the deterministic rules and is
 *   marked `pending`, so the panel can say "not judged yet" instead of implying
 *   the rules are the final answer.
 *
 * The pending entry is corrected on the next fold that sees a verdict, which is
 * what makes "the ledger may lag one step behind" true rather than merely hoped.
 *
 * @param {object} state - current state.
 * @param {object} event - committed session event.
 * @param {{resolve?: (text: string) => object|undefined}} [services] - verdict source.
 * @returns {object} next state, or the same reference.
 */
export function applyEvent(state, event, services = {}) {
  // Corrections ride along with the next fold: the host never recomputes a cell
  // because an out-of-band value changed, so this is the only place a late
  // verdict can take effect. On a normal event this is a cheap no-op.
  const corrected = refine(state, services)
  switch (event.type) {
    case 'turn/start': {
      const turn = Number(event.data?.turn)
      if (!Number.isSafeInteger(turn) || turn === corrected.openTurn) return corrected
      return { ...corrected, openTurn: turn }
    }
    case 'user/message': {
      const message = event.data
      const covered = event.surfaceOp?.op === 'replace' ? event.sourceEventSeqs ?? [] : []
      let next = corrected
      if (covered.length) next = retireCovered(corrected, covered)
      if (!isUserAuthored(message)) return next
      const text = messageText(message)
      if (text.trim() === '') return next
      const resolved = decide(text, services.resolve)
      if (resolved.candidates.length === 0) return next
      let current = next
      resolved.candidates.forEach((candidate, index) => {
        current = insertCandidate(current, {
          id: `d${event.seq}-${index}`,
          sourceSeq: event.seq,
          turn: current.openTurn,
          quote: candidate.text.slice(0, 240),
          authority: resolved.source === 'model' ? 'model-inferred' : candidate.checker !== undefined ? 'literal-anchored' : 'user-stated',
          judged: resolved.source,
          reason: resolved.reason,
        }, candidate)
      })
      return current
    }
    case 'command/run': {
      if (event.data?.name !== 'rule') return corrected
      const operation = parseRuleCommand(event.data?.args)
      if (operation === undefined) return corrected
      return applyRuleCommand(corrected, event, operation)
    }
    default:
      return corrected
  }
}

/**
 * Turn one message into the candidates the fold should record.
 *
 * A verdict that says `none` is authoritative: it means a model looked at the
 * sentence and concluded it is a bug report, a question, or a task for this turn
 * only. That is the whole point of paying for the judgement, so it must not be
 * second-guessed by the rules.
 *
 * @param {string} text - the user message.
 * @param {((text: string) => object|undefined)|undefined} resolve - verdict lookup.
 * @returns {{candidates: object[], source: string, reason: string}} decision and its provenance.
 */
export function decide(text, resolve) {
  const verdict = typeof resolve === 'function' ? resolve(text) : undefined
  if (verdict !== undefined) {
    if (verdict.kind === 'none') return { candidates: [], source: 'model', reason: verdict.reason ?? '判定为不是长期要求' }
    const candidates = Array.isArray(verdict.candidates) ? verdict.candidates : []
    return { candidates, source: 'model', reason: verdict.reason ?? '' }
  }
  const candidates = extractDirectives(text)
  if (candidates.length === 0) return { candidates: [], source: 'rules', reason: '' }
  return { candidates, source: 'rules', reason: '尚未判定，暂按规则匹配' }
}

/**
 * Re-decide every message whose verdict arrived after it was first folded.
 *
 * The host advances each projection cell by folding only the NEW events, and it
 * never recomputes a cell because an out-of-band value changed. A correction
 * therefore cannot be pushed in from outside; it has to ride along with the next
 * fold. `applyEvent` calls this at entry, and the cost stays bounded because it
 * only looks at entries still marked `judged: 'rules'` whose verdict is by now
 * cached — normally none.
 *
 * @param {object} state - current state.
 * @param {{resolve?: (text: string) => object|undefined}} services - verdict source.
 * @returns {object} corrected state, or the same reference when nothing moved.
 */
export function refine(state, services = {}) {
  if (typeof services.resolve !== 'function') return state
  const stale = Object.values(state.directives).filter((directive) => directive.judged === 'rules')
  if (stale.length === 0) return state
  const settled = stale.filter((directive) => services.resolve(directive.quote) !== undefined)
  if (settled.length === 0) return state

  let next = state
  const handled = new Set()
  for (const directive of settled) {
    if (handled.has(directive.sourceSeq)) continue
    handled.add(directive.sourceSeq)
    const siblings = Object.values(next.directives).filter((entry) => entry.sourceSeq === directive.sourceSeq && entry.judged === 'rules')
    if (siblings.length === 0) continue
    const resolved = decide(directive.quote, services.resolve)
    const directives = { ...next.directives }
    for (const sibling of siblings) delete directives[sibling.id]
    next = {
      ...next,
      directives,
      order: next.order.filter((id) => directives[id] !== undefined),
      revision: next.revision + 1,
    }
    resolved.candidates.forEach((candidate, index) => {
      next = insertCandidate(next, {
        id: `d${directive.sourceSeq}-${index}`,
        sourceSeq: directive.sourceSeq,
        turn: directive.turn,
        quote: candidate.text.slice(0, 240),
        authority: resolved.source === 'model' ? 'model-inferred' : 'user-stated',
        judged: resolved.source,
        reason: resolved.reason,
      }, candidate)
    })
  }
  return next
}

/** Mark directives whose originating prompt was replaced as retracted. */
function retireCovered(state, seqs) {
  const covered = new Set(seqs)
  let changed = false
  const directives = { ...state.directives }
  for (const directive of Object.values(state.directives)) {
    if (!covered.has(directive.sourceSeq) || directive.status === 'retracted') continue
    directives[directive.id] = { ...directive, status: 'retracted', supersededBy: null }
    changed = true
  }
  return changed ? { ...state, directives, revision: state.revision + 1 } : state
}

/** Apply a `/rule` subcommand to the ledger. */
function applyRuleCommand(state, event, operation) {
  if (operation.verb === 'list' || operation.verb === 'why') return state
  if (operation.verb === 'add') {
    const candidates = extractDirectives(operation.rest)
    const text = candidates.length > 0 ? candidates[0] : undefined
    if (text === undefined) return state
    return insertCandidate(state, {
      id: `c${event.seq}`,
      sourceSeq: event.seq,
      turn: state.openTurn,
      quote: operation.rest.slice(0, 240),
      authority: 'user-pinned',
    }, { ...text, kind: text.kind === 'pin' ? 'pin' : text.kind })
  }
  const id = resolveTarget(state, operation.rest)
  if (id === undefined) return state
  const directive = state.directives[id]
  if (operation.verb === 'drop') {
    if (directive.status === 'revoked') return state
    return {
      ...state,
      directives: { ...state.directives, [id]: { ...directive, status: 'revoked', supersededBy: null } },
      revision: state.revision + 1,
    }
  }
  // pin: promote to protected, restore it if it was retired, and take the topic
  // slot away from whatever replaced it.
  const directives = { ...state.directives }
  directives[id] = { ...directive, kind: 'pin', status: 'active', supersededBy: null }
  retireTopic(directives, directive.topicKey, id)
  return { ...state, directives, revision: state.revision + 1 }
}

/**
 * The client-facing summary, ordered chronologically.
 *
 * `injected` is supplied by the caller that rendered the standing block, so the
 * UI can distinguish "in force" from "actually reached the model". Without it a
 * budget-truncated entry would still look active in the panel, which is exactly
 * the kind of quiet lie this plugin exists to prevent.
 *
 * @param {object} state - ledger state.
 * @param {string[]} injectedIds - ids the rendered block contained.
 * @returns {object} wire value.
 */
export function viewState(state, injectedIds) {
  const injected = new Set(Array.isArray(injectedIds) ? injectedIds : [])
  const all = Object.values(state.directives).sort((left, right) => left.sourceSeq - right.sourceSeq
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  if (all.length === 0) return { revision: state.revision, injected: 0, items: [] }
  return {
    revision: state.revision,
    injected: injected.size,
    items: all.map((directive) => ({
      id: directive.id,
      text: directive.text,
      kind: directive.kind,
      topicKey: directive.topicKey,
      status: directive.status,
      sourceSeq: directive.sourceSeq,
      turn: directive.turn,
      authority: directive.authority,
      supersedes: directive.supersedes,
      supersededBy: directive.supersededBy,
      enforceable: directive.checker !== null,
      injected: injected.has(directive.id),
    })),
  }
}
