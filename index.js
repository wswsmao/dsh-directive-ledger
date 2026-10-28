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
import { nativePackage } from './lib/native.js'

const { z } = await nativePackage('zod')
const { createUserMessage } = await nativePackage('@deepseek-ai/dsh-llm')

/** Cordis plugin name. */
export const name = 'directive-ledger'

/** Services that must exist for the ledger to have any effect. */
export const inject = ['sessionProjections', 'systemPrompt', 'tools', 'commands', 'agents']

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
  return { budgetTokens, textLanguage, reminderMode, enforce }
}

const EMPTY_VIEW = Object.freeze({ revision: 0, injected: 0, items: [] })

/**
 * Mount the ledger.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated row config.
 */
export function apply(ctx, config = {}) {
  const options = readConfig(config)
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
    apply: applyEvent,
    wire: {
      viewSchema,
      view: (state) => viewOf(state, renderOf(state).included.map((directive) => directive.id)),
    },
    stateVersion: STATE_VERSION,
  }), 'directive-ledger: projection')

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
