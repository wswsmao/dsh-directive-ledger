/**
 * Host half: keeps the user's standing requirements visible on every step,
 * tracks which newer requirement replaced which older one, and blocks the
 * prohibitions it can actually verify.
 *
 * Everything model-visible is derived from the session log, so a restart, a
 * resume, or a compaction reconstructs the same ledger without plugin-owned
 * state. The only writable artifact is an optional classification cache, and
 * losing it degrades presentation, never correctness.
 *
 * @module directive-ledger
 */

import { PROJECTION_KEY, STATE_VERSION, applyEvent, emptyState } from './lib/ledger.js'
import { explain, listLedger, renderLedger } from './lib/render.js'
import { checkCall } from './lib/enforce.js'
import { extractDirectives } from './lib/extract.js'
import { reminderLines, reminderMessage } from './lib/remind.js'
import { registerRoute } from './lib/route.js'
import { judgeMessage } from './lib/judge.js'
import { openVerdicts, resolveDataDir, verdictKey } from './lib/verdicts.js'
import { nativePackage } from './lib/native.js'

const { z } = await nativePackage('zod')
const { createUserMessage } = await nativePackage('@deepseek-ai/dsh-llm')

/** Cordis plugin name. */
export const name = 'directive-ledger'

/**
 * Services the ledger needs.
 *
 * `llm` is required rather than optional: without it the plugin can only run the
 * deterministic rules, and those are exactly what produced the false pins this
 * version exists to remove. `webServer` and `connection` carry the browser's
 * delete action — without them the panel would render a button that cannot work,
 * and a visible lie is worse than the plugin staying inactive.
 */
export const inject = ['sessionProjections', 'systemPrompt', 'tools', 'commands', 'agents', 'llm', 'webServer', 'connection']

/** Where the reminder context sits: after the host's own facts, before tools. */
const CONTEXT_ORDER = 150

/** Projection schemas. Loose on purpose: an older reader must not reject a newer field. */
const checkerSchema = z.object({
  type: z.enum(['forbidden-write', 'forbidden-command']),
  value: z.string(),
})

const directiveSchema = z.object({
  id: z.string(),
  sourceSeq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  quote: z.string(),
  text: z.string(),
  kind: z.enum(['rule', 'preference', 'decision', 'ban', 'pin']),
  topicKey: z.string(),
  authority: z.enum(['user-pinned', 'user-stated', 'literal-anchored', 'model-inferred']),
  status: z.enum(['active', 'superseded', 'revoked', 'retracted']),
  supersedes: z.array(z.string()).readonly(),
  supersededBy: z.string().nullable(),
  checker: checkerSchema.nullable(),
  // Provenance of the decision: a semantic verdict, the deterministic rules, or
  // a user command. Optional so rows written by the previous version still load;
  // they are treated as rule-derived and corrected on the next fold.
  judged: z.enum(['model', 'rules', 'fallback']).optional(),
  reason: z.string().optional(),
})

const stateSchema = z.object({
  directives: z.record(z.string(), directiveSchema).readonly(),
  order: z.array(z.string()).readonly(),
  revision: z.number().int().nonnegative(),
  openTurn: z.number().int().nonnegative(),
})

const viewSchema = z.object({
  revision: z.number().int().nonnegative(),
  injected: z.number().int().nonnegative(),
  items: z.array(z.object({
    id: z.string(),
    text: z.string(),
    kind: z.string(),
    topicKey: z.string(),
    status: z.string(),
    sourceSeq: z.number(),
    turn: z.number(),
    authority: z.string(),
    supersedes: z.array(z.string()).readonly(),
    supersededBy: z.string().nullable(),
    enforceable: z.boolean(),
    injected: z.boolean(),
    judged: z.string().optional(),
    reason: z.string().optional(),
  })).readonly(),
})

/** Validate the row's config once, at activation. */
function readConfig(config) {
  const budgetTokens = config.budgetTokens ?? 800
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 64) throw new TypeError('budgetTokens must be an integer >= 64')
  const textLanguage = config.textLanguage ?? 'auto'
  if (!['auto', 'zh', 'en'].includes(textLanguage)) throw new TypeError("textLanguage must be 'auto', 'zh' or 'en'")
  const reminderMode = config.reminderMode ?? 'off'
  if (!['off', 'auto', 'always'].includes(reminderMode)) throw new TypeError("reminderMode must be 'off', 'auto' or 'always'")
  const enforce = config.enforce ?? 'guard'
  if (!['off', 'guard'].includes(enforce)) throw new TypeError("enforce must be 'off' or 'guard'")
  const extraction = config.extraction ?? 'semantic'
  if (!['semantic', 'deterministic'].includes(extraction)) throw new TypeError("extraction must be 'semantic' or 'deterministic'")
  const judgeTimeoutMs = config.judgeTimeoutMs ?? 8000
  if (!Number.isSafeInteger(judgeTimeoutMs) || judgeTimeoutMs < 1000) throw new TypeError('judgeTimeoutMs must be an integer >= 1000')
  const judgeProvider = typeof config.judgeProvider === 'string' ? config.judgeProvider.trim() : ''
  return {
    budgetTokens,
    textLanguage,
    reminderMode,
    enforce,
    extraction,
    judgeTimeoutMs,
    judgeProvider,
    dataDir: resolveDataDir(config.dataDir),
  }
}

const EMPTY_VIEW = Object.freeze({ revision: 0, injected: 0, items: [] })

/** Join one message's text blocks; the fold and the judge must see the same text. */
function textOfMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
}

/**
 * Mount the ledger.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated row config.
 */
export function apply(ctx, config = {}) {
  const options = readConfig(config)
  const warn = (message) => ctx.logger.warn(`[directive-ledger] ${message}`)
  const verdicts = openVerdicts(options.dataDir, { warn })
  ctx.effect(() => () => verdicts.close(), 'directive-ledger: verdict cache')

  /**
   * The synchronous face of the verdict cache, used by the fold.
   *
   * A message is keyed by its own text, so a verdict is reusable across sessions
   * and survives replay without being tied to any event position.
   */
  const resolve = options.extraction === 'semantic'
    ? (text) => verdicts.get(verdictKey(text))
    : undefined

  /** Ledger state for sessions that have no live cell yet. */
  const stateOf = (session) => ctx.sessionProjections.stateOf(session, PROJECTION_KEY) ?? emptyState()
  /**
   * The standing block plus the ids it actually contains.
   *
   * Both the prompt and the panel read this, so "in force" and "reached the
   * model" cannot drift apart: an entry dropped for budget is marked as not
   * injected instead of being presented as delivered.
   */
  const renderOf = (state) => renderLedger(state, options.budgetTokens, options.textLanguage)

  ctx.effect(() => ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateSchema,
    init: () => emptyState(),
    // The fold reads verdicts through `resolve`; it can never await one, so the
    // judge below fills the cache and `refine` applies it on the next event.
    apply: (state, event) => applyEvent(state, event, { resolve }),
    wire: {
      viewSchema,
      view: (state) => viewOf(state, renderOf(state).included.map((directive) => directive.id)),
    },
    stateVersion: STATE_VERSION,
  }), 'directive-ledger: projection')

  if (options.extraction === 'semantic') {
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const message = event.data
      if (message?.source?.kind !== 'user') return
      const text = textOfMessage(message)
      if (text.trim() === '') return
      if (resolve(text) !== undefined) return
      // The route the conversation is already using. Reading it once here keeps
      // the judge on the same model the user selected, so a provider that only
      // serves one model is not asked for another.
      const header = session.requestHeader()?.config
      const route = options.judgeProvider === ''
        ? { provider: header?.provider ?? '', model: header?.model ?? '' }
        : { provider: options.judgeProvider, model: header?.model ?? '' }
      if (route.provider === '' || route.model === '') {
        // No route yet (a brand-new session before its first request). The rules
        // still record the message and `refine` corrects it once a verdict is
        // possible, so skipping here loses nothing.
        return
      }
      // Fire and forget: the judgement must never delay or fail the turn. Its
      // result lands in the cache and is applied by the next fold.
      const active = Object.values(stateOf(session).directives).filter((directive) => directive.status === 'active')
      void judgeMessage({
        llm: ctx.llm,
        verdicts,
        text,
        active,
        options: { ...route, timeoutMs: options.judgeTimeoutMs, warn },
      }).catch((error) => warn(`judgement failed: ${error?.message ?? String(error)}`))
    }), 'directive-ledger: semantic judge')
  }

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'directive-ledger',
    order: CONTEXT_ORDER,
    required: true,
    text: (context) => {
      if (context.agent === undefined) return ''
      return renderOf(stateOf(context.agent.session)).text
    },
  }), 'directive-ledger: runtime context')

  if (options.enforce === 'guard') {
    ctx.effect(() => ctx.tools.guard((execution) => {
      if (execution.agent === undefined) return undefined
      const state = ctx.sessionProjections.stateOf(execution.agent.session, PROJECTION_KEY)
      if (state === undefined) return undefined
      return checkCall(state, execution)
    }), 'directive-ledger: tool guard')
  }

  if (options.reminderMode !== 'off') {
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      // A rejected step runs nothing, and an aborted turn must not gain input.
      if (decision.kind !== 'enter' || payload.signal.aborted) return decision
      const state = stateOf(payload.agent.session)
      const lines = reminderLines(state, decision.messages, {
        mode: options.reminderMode,
        step: payload.step,
        budgetTokens: options.budgetTokens,
      })
      if (lines.length === 0) return decision
      return { ...decision, messages: [...decision.messages, reminderMessage(lines, { createUserMessage })] }
    }), 'directive-ledger: pre-step reminder')
  }

  registerCommands(ctx, stateOf)
  registerRoute(ctx)
}

/** The client view; kept next to the schemas it must satisfy. */
function viewOf(state, injectedIds) {
  const injected = new Set(injectedIds)
  const items = Object.values(state.directives).map((directive) => ({
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
  }))
  if (items.length === 0) return EMPTY_VIEW
  items.sort((left, right) => left.sourceSeq - right.sourceSeq || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return { revision: state.revision, injected: injected.size, items }
}

/** `/rule` — read and edit the ledger without spending a model turn. */
function registerCommands(ctx, stateOf) {
  ctx.effect(() => ctx.commands.register({
    name: 'rule',
    description: '查看或修改当前会话的用户要求台账（list/why/pin/drop/add）',
    // The ledger is rebuilt from the log, so this input must be in the log.
    recordInput: true,
    input: { hint: 'list | why <id> | pin <id> | drop <id> | add <文本>' },
    handler({ agent, rawInput }) {
      const state = stateOf(agent.session)
      const match = /^\s*([a-z]+)\s*(.*)$/i.exec(rawInput ?? '')
      if (match === null) return { kind: 'error', text: '用法：/rule list | why <id> | pin <id> | drop <id> | add <文本>' }
      const verb = match[1].toLowerCase()
      const rest = match[2].trim()
      switch (verb) {
        case 'list':
          return { kind: 'success', text: listLedger(state) }
        case 'why': {
          const id = resolveId(state, rest)
          if (id === undefined) return { kind: 'error', text: `没有找到条目 "${rest}"。用 /rule list 查看编号。` }
          return { kind: 'success', text: explain(state, state.directives[id]) }
        }
        case 'pin':
        case 'drop': {
          const id = resolveId(state, rest)
          if (id === undefined) return { kind: 'error', text: `没有找到条目 "${rest}"。用 /rule list 查看编号。` }
          // The command has already been appended by the time the handler runs,
          // so the next fold applies it; report the intent, not a stale state.
          return { kind: 'success', text: `${verb === 'pin' ? '已固定' : '已撤销'} [${id}] ${state.directives[id].text}` }
        }
        case 'add': {
          const candidates = extractDirectives(rest)
          if (candidates.length === 0) return { kind: 'error', text: '无法从这段文本识别出要求，请写成明确的祈使句。' }
          return { kind: 'success', text: `已添加 ${candidates.length} 条要求（将在下一步生效）。` }
        }
        default:
          return { kind: 'error', text: '用法：/rule list | why <id> | pin <id> | drop <id> | add <文本>' }
      }
    },
  }), 'directive-ledger: /rule command')
}

/** Accept an exact id or a leading `#`/bare source sequence. */
function resolveId(state, rest) {
  if (rest === '') return undefined
  if (Object.hasOwn(state.directives, rest)) return rest
  const seq = String(rest).startsWith('#') ? Number(rest.slice(1)) : Number(rest)
  if (!Number.isSafeInteger(seq)) return undefined
  const found = Object.values(state.directives)
    .filter((directive) => directive.sourceSeq === seq && directive.status === 'active')
    .sort((left, right) => (left.id < right.id ? -1 : 1))
  return found[0]?.id
}
