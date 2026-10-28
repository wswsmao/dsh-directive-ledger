/**
 * Semantic judgement of one user message.
 *
 * The deterministic rules in `extract.js` match characters; they cannot tell that
 * "固定任务里面不能选模型" is a bug report about a feature called "固定任务" rather
 * than a request to pin a rule. That distinction is semantic, so it needs a model.
 *
 * Three properties keep this affordable and safe:
 *
 * 1. The call is isolated. It uses its own message array, no tools, and a purpose
 *    marker, so nothing about the judgement enters the conversation being judged.
 * 2. The call is bounded. A timeout degrades to the deterministic rules instead of
 *    stalling the turn.
 * 3. The call is cached. A verdict is a function of the message text, so the same
 *    sentence is judged at most once (see `verdicts.js`).
 *
 * @module directive-ledger/judge
 */

import { extractDirectives } from './extract.js'
import { JUDGE_PROMPT_VERSION, verdictKey } from './verdicts.js'

/** Purpose marker; also lets other plugins recognise and skip these calls. */
export const JUDGE_PURPOSE = 'directive-ledger-judge'

/** Kinds a verdict may take. `none` means "this is not a standing requirement". */
export const VERDICT_KINDS = Object.freeze(['rule', 'preference', 'decision', 'ban', 'pin', 'none'])

/** Known topic slots, offered to the judge so it reuses them instead of inventing keys. */
const TOPIC_TABLE = `
- output.language        语言偏好（用中文回答 / switch to English）
- tool.package-manager   包管理器（用 pnpm，不要用 npm）
- workflow.test-command  测试命令（测试一律跑 node --test）
- workflow.commit-policy 提交策略（提交前先跑 lint）
- workflow.plan-first    先方案后动手
- content.format         输出格式（结论写在最前面）
- path.forbidden-write:<path>  禁止改动某路径（path 用 / 分隔）
- general.<短标识>        以上都不匹配时的自定义槽位
`

/**
 * The judgement instruction.
 *
 * The bias is deliberate: `none` is the default, because a missed requirement
 * costs one less reminder, while a wrongly recorded one joins every future request
 * and — for `pin` — is exempt from automatic supersession.
 */
export const JUDGE_INSTRUCTION = `你是「用户要求台账」的判定器。判断用户这条消息是否在提出**需要跨轮次长期遵守的要求**。

只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。字段：

{
  "kind": "rule" | "preference" | "decision" | "ban" | "pin" | "none",
  "items": [{ "text": "...", "kind": "...", "topicKey": "...", "checker": {...} | null }],
  "supersedes": ["被本条推翻的旧条目 id"],
  "reason": "一句话说明为什么这样判"
}

## kind 的含义

- rule        长期有效的规则（以后都用中文回答）
- preference  风格偏好（结论写在最前面）
- decision    本次任务内的技术选型或结论（用方案 B）
- ban         明确禁止（不要动 D:\\prod、不要用 npm）
- pin         **仅当用户明确要求「把这条固定下来/钉住」时**才用；普通的祈使句绝不算 pin
- none        不是长期要求

## 判 none 的情形（默认倾向）

以下都判 none，宁缺勿滥：

1. **指向当前这一次任务的指令**：这里应该改一下、修复这个 bug、加个下拉、重新跑一遍。
2. **描述功能现状或缺陷**：某个功能现在不支持 X、这个列表里没有 Y、点了没反应。
3. **提问**：要不要用 X、能不能改、为什么没生效。
4. **讨论与协商**：我觉得可以、你看呢、这样行不行。
5. **一次性的上下文交代**：我在看日志、刚才那步失败了。

判断标准：如果这句话**只对本次任务成立**，做完就该失效，就判 none。
如果用户表达的是「以后每次都这样」「一律」「不要」这类跨轮次约束，才判 rule/preference/ban。

注意：产品功能名、按钮名、菜单名里出现的字（例如功能就叫「固定任务」）不是动作词，「固定任务」≠「把这条固定住」。

## 其他规则

- items 可以有多条（一条消息里提出多个要求时逐条拆开），最多 5 条。
- text 必须改写成不带「请/帮我」的祈使句，保留原句里的工具名、路径、版本、条件。
- topicKey 优先从下表选；都不匹配才用 general.<短标识>：
${TOPIC_TABLE}
- checker 只有 kind=ban 且能机器判定时才填，否则 null：
  - 禁止改动路径 → { "type": "forbidden-write", "value": "D:/prod" }
  - 禁止某命令或包管理器 → { "type": "forbidden-command", "value": "npm" }
- supersedes 只填你能确定被推翻的旧条目 id（见下方当前台账），没有就空数组。`

/** Render the current ledger so the judge can spot supersessions. */
function ledgerDigest(active) {
  if (active.length === 0) return '（当前台账为空）'
  return active.map((directive) => `- id=${directive.id} kind=${directive.kind} topic=${directive.topicKey} 文本：${directive.text}`).join('\n')
}

/**
 * Coerce one item from the model's reply into a candidate the fold understands.
 * @param {unknown} raw - one element of `items`.
 * @param {string} fallbackKind - the reply's top-level kind.
 * @returns {object|undefined} candidate, or undefined when unusable.
 */
function normalizeItem(raw, fallbackKind) {
  if (raw === null || typeof raw !== 'object') return undefined
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (text === '') return undefined
  const kind = VERDICT_KINDS.includes(raw.kind) ? raw.kind : fallbackKind
  if (!VERDICT_KINDS.includes(kind) || kind === 'none') return undefined
  const topicKey = typeof raw.topicKey === 'string' && raw.topicKey.trim() !== '' ? raw.topicKey.trim() : undefined
  let checker
  const candidate = raw.checker
  if (checker === undefined && candidate !== null && typeof candidate === 'object') {
    const type = candidate.type
    const value = typeof candidate.value === 'string' ? candidate.value.trim() : ''
    // Only the two shapes the guard can actually enforce are accepted; anything
    // else would look enforceable in the panel while doing nothing.
    if ((type === 'forbidden-write' || type === 'forbidden-command') && value !== '') checker = { type, value }
  }
  // A `pin` without an explicit user request is exactly the false positive this
  // module exists to prevent, so it is downgraded rather than trusted.
  return { text, kind: kind === 'pin' ? 'rule' : kind, ...(topicKey === undefined ? {} : { topicKey }), ...(checker === undefined ? {} : { checker }) }
}

/**
 * Validate the model's reply.
 * @param {string} reply - raw model text.
 * @returns {{kind: string, candidates: object[], supersedes: string[], reason: string}|undefined} verdict, or undefined when unparseable.
 */
export function parseVerdict(reply) {
  const text = String(reply ?? '').trim()
  // Tolerate a fenced block even though the instruction forbids one: models add
  // them, and rejecting a correct verdict over formatting wastes the call.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced === null ? text : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const kind = VERDICT_KINDS.includes(parsed.kind) ? parsed.kind : 'none'
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 240) : ''
  const supersedes = Array.isArray(parsed.supersedes)
    ? parsed.supersedes.filter((value) => typeof value === 'string').slice(0, 10)
    : []
  const rawItems = Array.isArray(parsed.items) ? parsed.items.slice(0, 5) : []
  const candidates = rawItems.map((item) => normalizeItem(item, kind)).filter((item) => item !== undefined)
  // `none`, or a reply that claims a kind but yields no usable item, means the
  // message states no standing requirement.
  if (kind === 'none' || candidates.length === 0) {
    return { kind: 'none', candidates: [], supersedes: [], reason: reason === '' ? '未识别出长期要求' : reason }
  }
  return { kind, candidates, supersedes, reason }
}

/**
 * Fold collected stream chunks into the reply text.
 * @param {object[]} chunks - stream chunks from the model call.
 * @returns {string} concatenated text.
 */
export function textFromChunks(chunks) {
  let text = ''
  for (const chunk of chunks) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

/**
 * Build the isolated message list for one judgement.
 * @param {string} text - the user message to judge.
 * @param {object[]} active - directives currently in force.
 * @returns {object[]} request messages.
 */
export function judgeMessages(text, active) {
  return [{
    role: 'user',
    content: [{
      type: 'text',
      text: `当前台账（用于判断取代关系）：\n${ledgerDigest(active)}\n\n待判定的用户消息：\n"""\n${text.slice(0, 4000)}\n"""`,
    }],
  }]
}

/**
 * Collect a full streamed reply under a deadline.
 * @param {AsyncIterable<object>} stream - model chunks.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<string>} reply text.
 */
async function collect(stream, signal) {
  const chunks = []
  for await (const chunk of stream) {
    signal.throwIfAborted()
    chunks.push(chunk)
  }
  return textFromChunks(chunks)
}

/**
 * Judge one message, cache first.
 *
 * @param {object} deps - collaborators.
 * @param {{stream: Function}} deps.llm - the host LLM service.
 * @param {{get: Function, set: Function}} deps.verdicts - verdict cache.
 * @param {string} deps.text - the user message.
 * @param {object[]} deps.active - directives in force, for supersession awareness.
 * @param {{provider: string, model: string, timeoutMs: number, signal?: AbortSignal, warn?: Function}} deps.options - route and bounds.
 * @returns {Promise<{verdict: object, source: 'cache'|'model'|'fallback', candidates: object[]}>} judgement and where it came from.
 */
export async function judgeMessage({ llm, verdicts, text, active, options }) {
  const key = verdictKey(text)
  const cached = verdicts.get(key)
  if (cached !== undefined) return { verdict: cached, source: 'cache', candidates: cached.candidates }

  const warn = options.warn ?? (() => {})
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('judge timeout')), Math.max(1000, options.timeoutMs))
  const onAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const stream = llm.stream({
      provider: options.provider,
      model: options.model,
      // Isolated: no tools, no history, no session binding. `purpose` marks the
      // call so other middleware can recognise it, and keeps it out of the
      // conversation the verdict is about.
      purpose: JUDGE_PURPOSE,
      messages: [{ role: 'system', content: [{ type: 'text', text: JUDGE_INSTRUCTION }] }, ...judgeMessages(text, active)],
      signal: controller.signal,
    })
    const reply = await collect(stream, controller.signal)
    const verdict = parseVerdict(reply)
    if (verdict === undefined) throw new Error('unparseable verdict')
    const record = { ...verdict, promptVersion: JUDGE_PROMPT_VERSION }
    verdicts.set(key, record)
    return { verdict: record, source: 'model', candidates: record.candidates }
  } catch (error) {
    // Every failure lands here by design: a judgement is an optimisation, so a
    // broken model route must not stop the conversation. The deterministic rules
    // still produce something, and the panel marks it as unjudged.
    warn(`semantic judgement fell back to rules: ${error?.message ?? String(error)}`)
    const candidates = extractDirectives(text)
    return {
      verdict: { kind: candidates.length === 0 ? 'none' : 'fallback', candidates, supersedes: [], reason: '判定不可用，已退回规则匹配' },
      source: 'fallback',
      candidates,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
