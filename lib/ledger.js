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

/** Bumped whenever the fold's fields or semantics change. */
export const STATE_VERSION = 1

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
  if (state.directives[id] !== undefined) return state
  const directives = { ...state.directives }
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
  }
  return { ...state, directives, order: [...state.order, id], revision: state.revision + 1 }
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
 * @param {object} state - current state.
 * @param {object} event - committed session event.
 * @returns {object} next state, or the same reference.
 */
export function applyEvent(state, event) {
  switch (event.type) {
    case 'turn/start': {
      const turn = Number(event.data?.turn)
      if (!Number.isSafeInteger(turn) || turn === state.openTurn) return state
      return { ...state, openTurn: turn }
    }
    case 'user/message': {
      const message = event.data
      const covered = event.surfaceOp?.op === 'replace' ? event.sourceEventSeqs ?? [] : []
      let next = state
      if (covered.length) next = retireCovered(state, covered)
      if (!isUserAuthored(message)) return next
      const text = messageText(message)
      if (text.trim() === '') return next
      const candidates = extractDirectives(text)
      if (candidates.length === 0) return next
      let current = next
      candidates.forEach((candidate, index) => {
        current = insertCandidate(current, {
          id: `d${event.seq}-${index}`,
          sourceSeq: event.seq,
          turn: current.openTurn,
          quote: candidate.text.slice(0, 240),
          authority: candidate.checker !== undefined ? 'literal-anchored' : 'user-stated',
        }, candidate)
      })
      return current
    }
    case 'command/run': {
      if (event.data?.name !== 'rule') return state
      const operation = parseRuleCommand(event.data?.args)
      if (operation === undefined) return state
      return applyRuleCommand(state, event, operation)
    }
    default:
      return state
  }
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
 * The client-facing summary. Bounded on purpose: the panel only needs enough
 * to render a list and explain a supersession chain.
 * @param {object} state - ledger state.
 * @returns {object} wire value, ordered chronologically.
 */
export function viewState(state) {
  const all = Object.values(state.directives).sort((left, right) => left.sourceSeq - right.sourceSeq
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  if (all.length === 0) return { revision: state.revision, items: [] }
  return {
    revision: state.revision,
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
    })),
  }
}
