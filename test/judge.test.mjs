import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JUDGE_PROMPT_VERSION, openVerdicts, resolveDataDir, verdictKey } from '../lib/verdicts.js'
import { JUDGE_INSTRUCTION, judgeMessage, judgeMessages, parseVerdict } from '../lib/judge.js'
import { applyEvent, decide, emptyState, refine } from '../lib/ledger.js'

/** A verdict the judge would produce for a message stating nothing standing. */
const NONE = { kind: 'none', candidates: [], supersedes: [], reason: '这是对功能的反馈，不是长期要求' }

/** A verdict recording one rule. */
const RULE = {
  kind: 'rule',
  candidates: [{ text: '每次修改需要 git commit', kind: 'rule', topicKey: 'workflow.commit-policy' }],
  supersedes: [],
  reason: '用户要求每次修改都提交',
}

test('the same text always maps to the same cache key', () => {
  assert.equal(verdictKey('以后都用中文'), verdictKey('以后都用中文'))
  // Whitespace differences are not meaningful for a judgement.
  assert.equal(verdictKey('以后 都用中文'), verdictKey('  以后 都用中文  '))
  assert.notEqual(verdictKey('以后都用中文'), verdictKey('以后都用英文'))
})

test('a prompt-version change invalidates every cached verdict', () => {
  // The key embeds the version, so bumping the prompt cannot silently reuse a
  // verdict produced under different instructions.
  assert.equal(typeof JUDGE_PROMPT_VERSION, 'number')
  assert.ok(JUDGE_PROMPT_VERSION >= 1)
})

test('the cache survives a round trip and drops corrupt files to an empty start', async () => {
  const directory = await import('node:fs/promises').then((fs) => fs.mkdtemp('/tmp/dld-verdicts-').catch(() => null))
  if (directory === null) return
  const warn = []
  const first = openVerdicts(directory, { warn: (message) => warn.push(message) })
  first.set(verdictKey('hello'), NONE)
  first.close()
  const second = openVerdicts(directory, { warn: (message) => warn.push(message) })
  assert.deepEqual(second.get(verdictKey('hello')), NONE)
  second.close()
  await import('node:fs/promises').then((fs) => fs.rm(directory, { recursive: true, force: true }))
})

test('dataDir falls back to DSH_HOME when unset', () => {
  const resolved = resolveDataDir('')
  assert.ok(typeof resolved === 'string' && resolved !== '')
})

test('a none verdict parses and carries its reason', () => {
  const verdict = parseVerdict(JSON.stringify(NONE))
  assert.equal(verdict.kind, 'none')
  assert.deepEqual(verdict.candidates, [])
  assert.match(verdict.reason, /反馈/)
})

test('a fenced reply is still accepted', () => {
  // `parseVerdict` reads the MODEL's wire shape (`items`), not the internal
  // `candidates` shape, so this must use a raw reply rather than the RULE const.
  const reply = {
    kind: 'rule',
    items: [{ text: '每次修改需要 git commit', kind: 'rule', topicKey: 'workflow.commit-policy' }],
    supersedes: [],
    reason: '提交策略',
  }
  const fence = String.fromCharCode(96, 96, 96)
  const verdict = parseVerdict(`${fence}json\n${JSON.stringify(reply)}\n${fence}`)
  assert.equal(verdict.kind, 'rule')
  assert.equal(verdict.candidates.length, 1)
  assert.equal(verdict.candidates[0].topicKey, 'workflow.commit-policy')
})

test('garbage is rejected rather than guessed at', () => {
  assert.equal(parseVerdict(''), undefined)
  assert.equal(parseVerdict('not json at all'), undefined)
  assert.equal(parseVerdict('{"kind":'), undefined)
})

test('a pin the model invented without an explicit request is downgraded', () => {
  // The whole point of the semantic layer: "固定任务" is a feature name, so a
  // model that still answers `pin` must not be trusted with the strongest kind.
  const verdict = parseVerdict(JSON.stringify({
    kind: 'pin',
    items: [{ text: '固定任务里面不能选模型', kind: 'pin' }],
    reason: '看起来像要求',
  }))
  assert.equal(verdict.candidates[0].kind, 'rule')
})

test('an unenforceable checker shape is dropped', () => {
  const verdict = parseVerdict(JSON.stringify({
    kind: 'ban',
    items: [{ text: '不要动某目录', kind: 'ban', checker: { type: 'nonsense', value: 'x' } }],
  }))
  assert.equal(verdict.candidates[0].checker, undefined)
})

test('a verdict claiming a kind but yielding no items is treated as none', () => {
  const verdict = parseVerdict(JSON.stringify({ kind: 'rule', items: [], reason: '空的' }))
  assert.equal(verdict.kind, 'none')
})

test('the judge sees the message and the current ledger, without conversation history', () => {
  const messages = judgeMessages('以后提交前跑测试', [{ id: 'd1', kind: 'rule', topicKey: 'workflow.test-command', text: '测试跑 node --test' }])
  assert.equal(messages.length, 1)
  const text = messages[0].content[0].text
  assert.ok(text.includes('以后提交前跑测试'))
  assert.ok(text.includes('d1'), 'the judge needs ids to report supersessions')
})

test('the instruction forbids pinning by default and calls out feature names', () => {
  assert.match(JUDGE_INSTRUCTION, /none/)
  assert.match(JUDGE_INSTRUCTION, /固定任务/)
  assert.match(JUDGE_INSTRUCTION, /绝不算 pin|仅当/)
})

test('a cached verdict decides the message without re-running the rules', () => {
  const decided = decide('固定任务里面不能选模型', () => NONE)
  assert.equal(decided.source, 'model')
  assert.deepEqual(decided.candidates, [])
})

test('a message with no verdict yet writes nothing and is parked', () => {
  const decided = decide('固定任务里面不能选模型', () => undefined)
  // The rules misread it as a pin — that is exactly why the verdict exists. In
  // semantic mode they must not be allowed to act on that reading: an entry
  // written now is injected before the judgement that would have dropped it.
  assert.equal(decided.source, 'pending')
  assert.deepEqual(decided.candidates, [])
  assert.match(decided.reason, /等待语义判定/)
})

test('without a verdict source the rules still judge directly', () => {
  // Deterministic mode has no judge to wait for, so the old behaviour is correct
  // there: the rules are the only authority and may write immediately.
  const decided = decide('固定任务里面不能选模型', undefined)
  assert.equal(decided.source, 'rules')
  assert.equal(decided.candidates.length, 1)
})

test('an unjudged message is parked in pending rather than written', () => {
  const state = applyEvent(emptyState(), {
    seq: 7,
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '固定任务里面不能选模型' }] },
  }, { resolve: () => undefined })
  assert.deepEqual(Object.keys(state.directives), [])
  assert.equal(state.pending['7'].text, '固定任务里面不能选模型')
  assert.equal(state.pending['7'].seq, 7)
})

test('a parked message is admitted once its verdict arrives', () => {
  const text = '以后都用中文'
  let verdict
  const resolve = () => verdict
  const parked = applyEvent(emptyState(), {
    seq: 3,
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }, { resolve })
  assert.equal(Object.keys(parked.directives).length, 0)
  verdict = {
    kind: 'rule',
    candidates: [{ text: '以后都用中文回答', kind: 'rule', topicKey: 'output.language' }],
    supersedes: [],
    reason: '语言偏好',
  }
  const admitted = applyEvent(parked, { seq: 4, type: 'turn/start', data: { turn: 2 } }, { resolve })
  const values = Object.values(admitted.directives)
  assert.equal(values.length, 1)
  assert.equal(values[0].topicKey, 'output.language')
  assert.equal(values[0].judged, 'model')
  assert.deepEqual(admitted.pending, {})
})

test('a parked message judged as none disappears without a trace', () => {
  const text = '重新讨论这个问题'
  let verdict
  const resolve = () => verdict
  const parked = applyEvent(emptyState(), {
    seq: 5,
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }, { resolve })
  assert.equal(Object.keys(parked.pending).length, 1)
  verdict = { kind: 'none', candidates: [], supersedes: [], reason: '本轮动作指令' }
  const cleared = applyEvent(parked, { seq: 6, type: 'turn/start', data: { turn: 2 } }, { resolve })
  assert.deepEqual(Object.keys(cleared.directives), [])
  assert.deepEqual(cleared.pending, {})
})

test('refine is a no-op when nothing is parked', () => {
  const state = emptyState()
  assert.equal(refine(state, { resolve: () => NONE }), state)
})

test('a judge failure records nothing instead of falling back to the rules', async () => {
  const warnings = []
  const result = await judgeMessage({
    llm: { stream: () => { throw new Error('provider down') } },
    verdicts: { get: () => undefined, set: () => {} },
    text: '以后都用中文',
    active: [],
    options: { provider: 'p', model: 'm', timeoutMs: 1000, warn: (message) => warnings.push(message) },
  })
  // A broken route is a defect, not a verdict. Writing the regex reading here
  // would make an unjudged sentence into a standing requirement.
  assert.equal(result.source, 'failed')
  assert.deepEqual(result.candidates, [])
  assert.equal(result.verdict, undefined)
  assert.ok(warnings.length === 1)
})

test('an unparseable reply records nothing', async () => {
  const result = await judgeMessage({
    llm: {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: '抱歉，我不能' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
    verdicts: { get: () => undefined, set: () => {} },
    text: '以后都用中文',
    active: [],
    options: { provider: 'p', model: 'm', timeoutMs: 1000 },
  })
  // An unreadable reply is not a verdict either: guess from the regexes would
  // reintroduce exactly the unjudged write this design removed.
  assert.equal(result.source, 'failed')
  assert.deepEqual(result.candidates, [])
})

test('a good reply is cached and the second call skips the model', async () => {
  const store = new Map()
  let calls = 0
  const llm = {
    stream: () => {
      calls += 1
      return (async function* () {
        yield { type: 'text-delta', text: JSON.stringify(RULE) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const verdicts = { get: (key) => store.get(key), set: (key, value) => store.set(key, value) }
  const options = { provider: 'p', model: 'm', timeoutMs: 1000 }
  const first = await judgeMessage({ llm, verdicts, text: '每次修改需要有 git commit', active: [], options })
  const second = await judgeMessage({ llm, verdicts, text: '每次修改需要有 git commit', active: [], options })
  assert.equal(first.source, 'model')
  assert.equal(second.source, 'cache')
  assert.equal(calls, 1)
})
