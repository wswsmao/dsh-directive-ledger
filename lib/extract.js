/**
 * Deterministic extraction of standing user requirements.
 *
 * This is the P0 half of the design's two-stage extractor: it never calls a
 * model, so every candidate is reproducible from the message text alone. The
 * optional model-assisted stage only refines what this module already found.
 *
 * @module directive-ledger/extract
 */

/** Directive kinds. `rule`/`preference` are standing, `decision` is task-local. */
export const KINDS = Object.freeze(['rule', 'preference', 'decision', 'ban', 'pin'])

/** Above this many characters a clause is treated as prose, not a requirement. */
const MAX_CLAUSE = 200
/** Below this many characters a clause carries no usable requirement. */
const MIN_CLAUSE = 4

const BAN = /(?:不要|不用|别|禁止|严禁|不许|不准|不得|勿|避免)|\b(?:never|don'?t|do not|must not|avoid|no longer)\b/i
const MUST = /(?:必须|务必|一定要|记得|请一定|只能|只允许|只用于|只用来|一律|统一|始终保持)|\b(?:must|always|make sure|be sure|only ever)\b/i
const STANDING = /(?:以后|今后|之后都|接下来都|从现在起|从今以后|长期|每次|一律)|\b(?:from now on|going forward|henceforth|in future)\b/i
const SUPERSEDE = /(?:改成|改为|换成|改用|不用.{0,8}了|算了|还是用|撤回|取消之前|其实用)|(?:\binstead\b|change to|switch to|never ?mind|forget (?:that|it)|actually use|scrap)/i
const PIN = /(?:固定|钉住|记住这条|这条别动)|\bpin\b/i

const PACKAGE_MANAGER = /\b(npm|pnpm|yarn|bun|pip|poetry|uv|cargo)\b/i
const LANGUAGE = /(?:中文|汉语|简体|繁体|英文|英语|日文|日语)|(?:\bEnglish\b|\bChinese\b|\bJapanese\b)/i
const TEST_WORK = /(?:测试|单测|跑测试|回归|lint|typecheck|类型检查)|\b(?:test|tests|spec|lint|typecheck)\b/i
const COMMIT_WORK = /(?:提交|commit|push|推送)|\b(?:commit|push)\b/i
const PLAN_WORK = /(?:先说方案|先给方案|先说思路|方案先行|先讨论|不要直接改)|\b(?:plan first|propose first)\b/i
const FORMAT_WORK = /(?:结论|格式|字数|简洁|详细|分点|表格|Markdown)|\b(?:format|concise|verbose|bullet)\b/i
const WRITE_VERB = /(?:修改|改动|删除|删除掉|覆盖|写入|新增|创建|清理|动)|(?:\b(?:modify|change|delete|overwrite|write|create|touch|clean)\b)/i

const BACKTICK = /`([^`\n]{1,120})`/g
// Path literals are often wrapped in backticks or quotes; stop at the closing
// delimiter so `D:\prod` yields "D:\prod", not "D:\prod`".
const WIN_PATH = /[A-Za-z]:\\[^\s"'<>|,;，。、）)】\]`]*/g
const POSIX_PATH = /(?:^|[\s"'`(（])(\/[A-Za-z0-9._\-/]{2,120})/g

/** Characters that only delimit a path when they appear inside it. */
const TRAILING = /[.,;:、，。；：)\]】」』"'`>]+$/

/**
 * Normalize a path literal for stable comparison.
 * @param {string} value - raw path text.
 * @returns {string} slash-separated path without a trailing separator or punctuation.
 */
export function normalizePath(value) {
  const stripped = String(value).trim().replace(TRAILING, '')
  return stripped.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Whether the text contains CJK characters. */
export function hasCJK(text) {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(text)
}

/**
 * Where an instruction can begin inside an otherwise-labelled sentence.
 * `只用于` counts because it constrains its own clause rather than announcing a
 * fresh one: "一级标题只用于划分主题，不得写成要点" must stay together.
 */
const INSTRUCTION_HEAD = /(?:以后|今后|从现在起|每次|一律|不要|不用|别|禁止|严禁|不得|不准|必须|务必|只能|只允许|只用于|只用来|记得|from now on|always|never|do not|must)/i

/**
 * Split one message into candidate clauses.
 *
 * A comma is usually internal: "一级标题只用于划分顶层主题，不得写成要点" states
 * one constraint whose two halves share a subject, and cutting it there leaves a
 * fragment with no subject. A comma IS a boundary when the part before it says
 * nothing imperative and the part after it starts one — that is how a scope
 * label ("对象是：每一轮的对话，不用考虑跨对话") or a preamble ("可以开发了，
 * 每次修改要提交") precedes the requirement it introduces.
 *
 * @param {string} text - user message text.
 * @returns {string[]} trimmed, non-empty clauses with their terminator.
 */
export function splitClauses(text) {
  const source = String(text)
  const parts = []
  let current = ''
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if ('\n。；;！!？?'.includes(character)) {
      if (current.trim() !== '') parts.push(`${current.trim()}${character}`)
      current = ''
      continue
    }
    if ('，,'.includes(character) && startsInstruction(source.slice(index + 1)) && !INSTRUCTION_HEAD.test(current)) {
      if (current.trim() !== '') parts.push(`${current.trim()}${character}`)
      current = ''
      continue
    }
    current += character
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= MIN_CLAUSE && clause.length <= MAX_CLAUSE)
}

/**
 * Whether the text right after a comma begins a new instruction.
 * @param {string} rest - the remaining source text.
 * @returns {boolean} true when an instruction head appears before the next terminator.
 */
function startsInstruction(rest) {
  const segment = rest.split(/[\n。；;！!？?，,]/)[0].trim()
  return segment.length >= MIN_CLAUSE && INSTRUCTION_HEAD.test(segment)
}

/**
 * Strip a leading enumeration or discourse marker.
 * @param {string} clause - clause text.
 * @returns {string} the clause without its marker.
 */
export function stripLabel(clause) {
  return String(clause)
    .replace(/^\s*\d+\s*[、.)）:：]\s*/, '')
    .replace(/^(?:注意|另外|还有|其次|首先|补充|顺便)\s*[：:，,]?\s*/, '')
    .trim()
}

/** First path literal in the text, if any. */
function firstPath(text) {
  const win = text.match(WIN_PATH)
  if (win && win.length) return normalizePath(win[0])
  const posix = [...text.matchAll(POSIX_PATH)].map((match) => match[1])
  // Skip single-slash fragments that are really prose ("和/或").
  const candidate = posix.find((value) => value.length > 3 && value.split('/').filter(Boolean).length >= 2)
  return candidate === undefined ? undefined : normalizePath(candidate)
}

/** First backticked command literal, if any. */
function firstCommand(text) {
  for (const match of text.matchAll(BACKTICK)) return match[1].trim()
  return undefined
}

/**
 * Infer the supersession slot for one clause.
 *
 * The key is what makes "改成 pnpm" replace "用 npm" instead of existing beside
 * it, so it must be stable across phrasings — hence a fixed table rather than a
 * generated label.
 *
 * @param {string} clause - normalized clause text.
 * @param {'ban'|'rule'|'preference'|'decision'|'pin'} kind - intended kind.
 * @returns {string} topic key.
 */
export function inferTopicKey(clause, kind) {
  const base = baseTopicKey(clause, kind)
  // A prohibition and an instruction are different intents even on one subject:
  // "用 pnpm" and "别再提 npm" must both stay live. Sharing a slot would make
  // the second silently repeal the first.
  return kind === 'ban' ? `ban.${base}` : base
}

/** The subject slot, before the prohibition namespace is applied. */
function baseTopicKey(clause, kind) {
  const path = firstPath(clause)
  if (path !== undefined) {
    // The path is part of the key: forbidding one directory must not silently
    // replace the ban on another one.
    if (kind === 'ban' || (WRITE_VERB.test(clause) && BAN.test(clause))) return `path.forbidden-write:${path}`
    return `path.target:${path}`
  }
  const manager = clause.match(PACKAGE_MANAGER)
  if (manager) return 'tool.package-manager'
  if (LANGUAGE.test(clause)) return 'output.language'
  if (TEST_WORK.test(clause)) return 'workflow.test-command'
  if (COMMIT_WORK.test(clause)) return 'workflow.commit-policy'
  if (PLAN_WORK.test(clause)) return 'workflow.plan-first'
  if (firstCommand(clause) !== undefined) return 'tool.command'
  if (FORMAT_WORK.test(clause)) return 'content.format'
  // Unclassified clauses get a key derived from their own text so a repeated
  // wording still supersedes its earlier occurrence.
  return `general.${hashKey(clause)}`
}

/** Stable short hash used only for unclassified topic keys. */
function hashKey(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Classify one clause.
 * @param {string} clause - trimmed clause text.
 * @returns {'ban'|'rule'|'decision'|'pin'|undefined} kind, or undefined when the clause is not a requirement.
 */
export function classify(clause) {
  const supersedes = SUPERSEDE.test(clause)
  const standing = STANDING.test(clause)
  if (PIN.test(clause)) return 'pin'
  if (BAN.test(clause)) return 'ban'
  if (MUST.test(clause) || standing) return 'rule'
  if (supersedes) return 'decision'
  // "用 npm 装依赖吧" states a task decision without any marker word. The
  // package-manager list is closed and short, so admitting it here captures the
  // design's turn-9 requirement without opening the door to arbitrary prose.
  if (PACKAGE_MANAGER.test(clause)) return 'decision'
  return undefined
}

/** The prohibition marker alone, used to locate what is being forbidden. */
const BAN_MARKER = /(?:不要|不用|别|禁止|严禁|不许|不准|不得|勿|避免)|\b(?:never|don'?t|do not|must not|avoid)\b/i

/**
 * The part of a clause that names the forbidden thing.
 *
 * "算了，还是用 pnpm，别再提 npm" forbids npm and asks for pnpm. Reading the
 * first package manager in the whole clause would enforce exactly the wrong
 * one, so the checker looks after the prohibition marker when there is one.
 * @param {string} clause - clause text.
 * @returns {string} the segment a checker should inspect.
 */
export function bannedSegment(clause) {
  const marker = BAN_MARKER.exec(clause)
  if (marker === null) return clause
  const after = clause.slice(marker.index + marker[0].length).trim()
  return after === '' ? clause : after
}

/**
 * Build the machine-checkable predicate for a directive, when one exists.
 * Only prohibitions over concrete paths or commands are enforceable; everything
 * else stays advisory by design.
 * @param {string} clause - clause text.
 * @param {string} kind - directive kind.
 * @param {string} topicKey - inferred topic key.
 * @returns {{type: string, value: string}|undefined} checker spec, or undefined.
 */
export function inferChecker(clause, kind, topicKey) {
  if (kind !== 'ban') return undefined
  const target = bannedSegment(clause)
  if (topicKey.includes('path.forbidden-write:')) {
    const path = firstPath(target) ?? firstPath(clause)
    return path === undefined ? undefined : { type: 'forbidden-write', value: path }
  }
  if (topicKey.endsWith('tool.command')) {
    const command = firstCommand(target) ?? firstCommand(clause)
    return command === undefined ? undefined : { type: 'forbidden-command', value: command }
  }
  if (topicKey.endsWith('tool.package-manager')) {
    const manager = target.match(PACKAGE_MANAGER)
    return manager === undefined ? undefined : { type: 'forbidden-command', value: manager[1].toLowerCase() }
  }
  return undefined
}

/**
 * Extract candidate directives from one user message.
 * @param {string} text - the user's message text.
 * @returns {Array<{text: string, kind: string, topicKey: string, checker?: {type: string, value: string}}>} candidates in message order.
 */
export function extractDirectives(text) {
  const found = []
  const seen = new Set()
  for (const raw of splitClauses(text)) {
    // "要不要用 X?" is a question, not a requirement. Checking before
    // classification matters because "要不要" contains the prohibition "不要".
    if (isQuestion(raw)) continue
    const clause = stripLabel(raw.replace(/[。,，；;！!？?]+$/, '')).trim()
    if (clause.length < MIN_CLAUSE) continue
    const kind = classify(clause)
    if (kind === undefined) continue
    const topicKey = inferTopicKey(clause, kind)
    const dedupe = `${topicKey}\u0000${clause}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const checker = inferChecker(clause, kind, topicKey)
    found.push({ text: clause, kind, topicKey, ...(checker === undefined ? {} : { checker }) })
  }
  return found
}

/**
 * Whether one clause asks a question rather than stating a requirement.
 * @param {string} clause - clause text, terminator included.
 * @returns {boolean} true for questions.
 */
export function isQuestion(clause) {
  if (/[？?]\s*$/.test(clause)) return true
  return /^(?:要不要|是否|能否|可不可以|可以吗|行吗|对吗|好不好)/.test(clause)
}
