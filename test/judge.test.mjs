import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JUDGE_PROMPT_VERSION, openVerdicts, resolveDataDir, verdictKey } from '../lib/verdicts.js'
import { JUDGE_INSTRUCTION, judgeMessage, judgeMessages, parseVerdict } from '../lib/judge.js'
import { decide, refine } from '../lib/ledger.js'

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

test('a message with no verdict yet falls back to rules and is marked pending', () => {
  const decided = decide('固定任务里面不能选模型', () => undefined)
  // The rules still misread it as a pin — that is exactly why the verdict exists,
  // and why the entry is marked pending rather than presented as settled.
  assert.equal(decided.source, 'rules')
  assert.equal(decided.candidates.length, 1)
  assert.match(decided.reason, /尚未判定/)
})

test('refine removes entries the verdict says are not requirements', () => {
  const state = {
    directives: {
      'd1-0': {
        id: 'd1-0', sourceSeq: 1, turn: 1, quote: '固定任务里面不能选模型', text: '固定任务里面不能选模型',
        kind: 'pin', topicKey: 'general.x', authority: 'user-stated', status: 'active',
        supersedes: [], supersededBy: null, checker: null, judged: 'rules', reason: '',
      },
    },
    order: ['d1-0'],
    revision: 1,
    openTurn: 1,
  }
  const corrected = refine(state, { resolve: () => NONE })
  assert.equal(Object.keys(corrected.directives).length, 0)
  assert.deepEqual(corrected.order, [])
})

test('refine replaces a pending entry with the verdicts candidates', () => {
  const state = {
    directives: {
      'd1-0': {
        id: 'd1-0', sourceSeq: 1, turn: 1, quote: '以后都用中文', text: '以后都用中文',
        kind: 'rule', topicKey: 'general.x', authority: 'user-stated', status: 'active',
        supersedes: [], supersededBy: null, checker: null, judged: 'rules', reason: '',
      },
    },
    order: ['d1-0'],
    revision: 1,
    openTurn: 1,
  }
  const corrected = refine(state, {
    resolve: () => ({
      kind: 'rule',
      candidates: [{ text: '以后都用中文回答', kind: 'rule', topicKey: 'output.language' }],
      supersedes: [],
      reason: '语言偏好',
    }),
  })
  const values = Object.values(corrected.directives)
  assert.equal(values.length, 1)
  assert.equal(values[0].topicKey, 'output.language')
  assert.equal(values[0].judged, 'model')
})

test('refine is a no-op when nothing is pending', () => {
  const state = { directives: {}, order: [], revision: 0, openTurn: 0 }
  assert.equal(refine(state, { resolve: () => NONE }), state)
})

test('a judge failure falls back to the rules instead of throwing', async () => {
  const warnings = []
  const result = await judgeMessage({
    llm: { stream: () => { throw new Error('provider down') } },
    verdicts: { get: () => undefined, set: () => {} },
    text: '以后都用中文',
    active: [],
    options: { provider: 'p', model: 'm', timeoutMs: 1000, warn: (message) => warnings.push(message) },
  })
  assert.equal(result.source, 'fallback')
  assert.equal(result.candidates.length, 1)
  assert.ok(warnings.length === 1)
})

test('an unparseable reply also falls back', async () => {
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
  assert.equal(result.source, 'fallback')
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
