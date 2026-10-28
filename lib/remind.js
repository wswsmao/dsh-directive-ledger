/**
 * Optional per-step reminder.
 *
 * The ledger is already visible through the runtime context, so this module is
 * deliberately narrow. It fires only when a reminder adds information the
 * standing block does not carry: at the moment a new message supersedes an
 * older requirement (`auto`), or as an opt-in echo at the start of a turn
 * (`always`).
 *
 * The appended message carries its own source kind, which keeps it out of the
 * extractor's input — a reminder that fed itself back into the ledger would
 * invent requirements the user never stated.
 *
 * @module directive-ledger/remind
 */

import { extractDirectives } from './extract.js'
import { activeDirectives } from './ledger.js'
import { estimateTokens } from './render.js'

/**
 * Join the text blocks of one message.
 * @param {object} message - a user message.
 * @returns {string} its text.
 */
export function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
}

/** Truncate to the durable summary bound the host uses for notices. */
function summary(text) {
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`
}

/**
 * Decide whether a step needs a reminder, and what it should say.
 *
 * `auto` reacts to the supersession itself: that is exactly the step where a
 * model is most likely to keep following the requirement that was just
 * replaced. `always` echoes the highest-priority entries at the first step.
 *
 * @param {object} state - ledger state before the incoming batch is applied.
 * @param {object[]} messages - the batch about to enter this step.
 * @param {{mode: string, step: number, budgetTokens: number}} options - reminder settings.
 * @returns {string[]} reminder lines, empty when no reminder is warranted.
 */
export function reminderLines(state, messages, options) {
  if (options.mode === 'off') return []
  if (options.mode === 'always') {
    if (options.step !== 1) return []
    const top = activeDirectives(state).slice(0, 3)
    if (top.length === 0) return []
    return ['本轮仍然生效的用户要求：', ...top.map((directive) => `- ${directive.text}`)]
  }
  // auto: only when this batch replaces a requirement that is still on record.
  const inForce = activeDirectives(state)
  if (inForce.length === 0) return []
  const lines = []
  for (const message of messages) {
    if (message?.source?.kind !== 'user') continue
    for (const candidate of extractDirectives(textOf(message))) {
      const previous = inForce.find((directive) => directive.topicKey === candidate.topicKey && directive.text !== candidate.text)
      if (previous === undefined) continue
      lines.push(`- 新要求「${candidate.text}」取代了旧要求「${previous.text}」；以新的为准。`)
    }
  }
  if (lines.length === 0) return []
  let used = 0
  const bounded = []
  for (const line of lines) {
    const cost = estimateTokens(line)
    if (bounded.length > 0 && used + cost > options.budgetTokens) break
    bounded.push(line)
    used += cost
  }
  return ['用户刚刚更新了要求，注意不要沿用旧结论：', ...bounded]
}

/**
 * Build the reminder message. Kept separate so the listener stays synchronous
 * apart from this single construction.
 * @param {string[]} lines - reminder content.
 * @param {{createUserMessage: Function}} llm - host message factory.
 * @returns {object} a user-role message with a plugin-owned source.
 */
export function reminderMessage(lines, llm) {
  const text = lines.join('\n')
  return llm.createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'directive-ledger', form: 'notice', summary: summary(lines[1] ?? text) },
  })
}
