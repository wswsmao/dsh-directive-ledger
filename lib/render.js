/**
 * Rendering the ledger for the model, and for the failing budget.
 *
 * The output must be BYTE-STABLE for an unchanged ledger: the host compares the
 * rendered runtime-context snapshot with the one it already retained, and every
 * difference writes a new durable `user/message`. A timestamp, a locale-dependent
 * number format, or a Map iteration order would therefore cost one extra message
 * per step and destroy prefix-cache reuse.
 *
 * @module directive-ledger/render
 */

import { KIND_RANK, activeDirectives } from './ledger.js'
import { hasCJK } from './extract.js'

/** Kind badges shown to the model; short on purpose. */
const BADGE = Object.freeze({
  pin: 'PIN',
  ban: 'BAN',
  rule: 'RULE',
  preference: 'PREF',
  decision: 'DEC',
})

const HEADER = Object.freeze({
  zh: '仍然生效的用户要求（越新的条目会取代越旧的）：',
  en: 'Standing user requirements still in force (newer entries replace older ones):',
})

const OMITTED = Object.freeze({
  zh: (count) => `（另有 ${count} 条因长度未列出；不要假设它们不生效。）`,
  en: (count) => `(${count} more requirement(s) omitted for length; do not assume they no longer apply.)`,
})

/**
 * Cheap deterministic token estimate: one token per CJK character, roughly four
 * characters per token otherwise. Avoids depending on a provider tokenizer for a
 * budget that only decides how much text is worth showing.
 * @param {string} text - text to measure.
 * @returns {number} estimated tokens.
 */
export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const character of String(text)) {
    if (/[\u3000-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(character)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** Resolve the rendering language for one ledger. */
function languageOf(active, configured) {
  if (configured === 'zh' || configured === 'en') return configured
  return active.some((directive) => hasCJK(directive.text)) ? 'zh' : 'en'
}

/** One line per directive; no clock, no counters that drift. */
function line(directive) {
  const badge = BADGE[directive.kind] ?? 'RULE'
  const origin = `t${directive.turn}`
  const gate = directive.checker === null ? '' : ' [enforced]'
  return `- [${badge}] ${directive.text} (${origin})${gate}`
}

/**
 * Select the directives that fit the budget.
 *
 * Over-budget entries are not silently dropped: they are returned separately so
 * the panel can say "not injected", which is the difference between a degraded
 * reminder and a lie about what the model was told.
 *
 * @param {object} state - ledger state.
 * @param {number} budgetTokens - soft cap for the rendered block.
 * @param {string} configuredLanguage - `auto` or an explicit language.
 * @returns {{included: object[], omitted: object[], text: string, language: string}} selection and its rendering.
 */
export function renderLedger(state, budgetTokens, configuredLanguage = 'auto') {
  const active = activeDirectives(state)
  if (active.length === 0) return { included: [], omitted: [], text: '', language: languageOf([], configuredLanguage) }
  const language = languageOf(active, configuredLanguage)
  const included = []
  const omitted = []
  let used = 0
  for (const directive of active) {
    const cost = estimateTokens(line(directive))
    // Always render the first entry so a single oversized rule still reaches the model.
    if (included.length > 0 && used + cost > budgetTokens) {
      omitted.push(directive)
      continue
    }
    included.push(directive)
    used += cost
  }
  const body = included.map(line).join('\n')
  const tail = omitted.length === 0 ? '' : `\n${OMITTED[language](omitted.length)}`
  return { included, omitted, language, text: `${HEADER[language]}\n${body}${tail}` }
}

/**
 * Describe one supersession for the `/rule why` answer.
 * @param {object} state - ledger state.
 * @param {object} directive - the directive to explain.
 * @returns {string} human-readable explanation.
 */
export function explain(state, directive) {
  const parts = [`[${directive.id}] ${directive.text}`, `来源：第 ${directive.turn} 轮（事件 #${directive.sourceSeq}）`]
  if (directive.supersedes.length > 0) {
    const names = directive.supersedes.map((id) => state.directives[id]?.text ?? id)
    parts.push(`它推翻了：${names.join('；')}`)
  }
  if (directive.supersededBy !== null) parts.push(`它已被 ${directive.supersededBy} 推翻`)
  if (directive.status !== 'active') parts.push(`当前状态：${directive.status}`)
  if (directive.checker !== null) parts.push(`可强制执行：${directive.checker.type} → ${directive.checker.value}`)
  return parts.join('\n')
}

/**
 * The `/rule list` answer, grouped so retirement reasons stay distinct.
 * @param {object} state - ledger state.
 * @returns {string} human-readable listing.
 */
export function listLedger(state) {
  const all = Object.values(state.directives)
  if (all.length === 0) return '台账为空：还没有识别到明确的长期要求。用 /rule add <文本> 手动添加。'
  const groups = [
    ['生效中', all.filter((directive) => directive.status === 'active')],
    ['已取代', all.filter((directive) => directive.status === 'superseded')],
    ['已撤销', all.filter((directive) => directive.status === 'revoked')],
    ['已失效（来源被编辑）', all.filter((directive) => directive.status === 'retracted')],
  ]
  const sections = []
  for (const [title, directives] of groups) {
    if (directives.length === 0) continue
    const sorted = [...directives].sort((left, right) => (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9) || left.sourceSeq - right.sourceSeq)
    sections.push(`${title}：\n${sorted.map((directive) => `  ${BADGE[directive.kind] ?? 'RULE'} [${directive.id}] ${directive.text}`).join('\n')}`)
  }
  return sections.join('\n\n')
}
