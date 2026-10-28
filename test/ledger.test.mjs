import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PROJECTION_KEY, applyEvent, emptyState, viewState } from '../lib/ledger.js'
import { renderLedger, listLedger } from '../lib/render.js'

/** Build one user message event the way the host shapes it. */
function userMessage(seq, turn, text, extra = {}) {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: {
      id: `m${seq}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
    ...extra,
  }
}

const turnStart = (seq, turn) => ({ type: 'turn/start', seq, time: seq, data: { turn } })

/** Fold a list of events into a ledger state. */
function fold(events) {
  return events.reduce((state, event) => applyEvent(state, event), emptyState())
}

/** The conversation from the design document, turns 2 through 38. */
const FIXTURE = [
  turnStart(1, 1),
  turnStart(2, 2), userMessage(3, 2, '以后都用中文回答'),
  turnStart(4, 9), userMessage(5, 9, '用 npm 装依赖吧'),
  turnStart(6, 14), userMessage(7, 14, '不要动 `D:\\prod` 下的任何文件'),
  turnStart(8, 21), userMessage(9, 21, '算了，还是用 pnpm，别再提 npm'),
  turnStart(10, 31), userMessage(11, 31, '方案改用 B'),
]

test('the projection key is stable for the client wire contract', () => {
  assert.equal(PROJECTION_KEY, 'directiveLedger')
})

test('the design fixture leaves exactly one live entry per topic', () => {
  const state = fold(FIXTURE)
  const active = Object.values(state.directives).filter((directive) => directive.status === 'active')
  const topics = active.map((directive) => directive.topicKey)
  assert.equal(new Set(topics).size, topics.length, 'two active entries share a topic slot')

  const byTopic = Object.fromEntries(active.map((directive) => [directive.topicKey, directive]))
  assert.equal(byTopic['output.language'].text, '以后都用中文回答')
  assert.equal(byTopic['tool.package-manager'].text, '算了，还是用 pnpm，别再提 npm')
  assert.equal(byTopic['path.forbidden-write:D:/prod'].text, '不要动 `D:\\prod` 下的任何文件')
  assert.equal(byTopic['general.' + Object.keys(byTopic).find((key) => key.startsWith('general.'))?.slice(8)]?.kind, 'decision')
})

test('the superseded requirement keeps its history', () => {
  const state = fold(FIXTURE)
  const active = Object.values(state.directives).find((directive) => directive.topicKey === 'tool.package-manager' && directive.status === 'active')
  assert.equal(active.supersedes.length, 1)
  const previous = state.directives[active.supersedes[0]]
  assert.equal(previous.text, '用 npm 装依赖吧')
  assert.equal(previous.status, 'superseded')
  assert.equal(previous.supersededBy, active.id)
})

test('a merged feed reports the retired chain in one view', () => {
  const state = fold(FIXTURE)
  const view = viewState(state)
  const npm = view.items.find((item) => item.text === '用 npm 装依赖吧')
  const pnpm = view.items.find((item) => item.text === '算了，还是用 pnpm，别再提 npm')
  assert.equal(npm.status, 'superseded')
  assert.equal(npm.supersededBy, pnpm.id)
  assert.equal(pnpm.status, 'active')
})

test('a pinned requirement survives an automatic replacement', () => {
  const events = [
    turnStart(1, 1),
    turnStart(2, 2), userMessage(3, 2, '记住这条：回答一律中文'),
    { type: 'command/run', seq: 4, time: 4, data: { commandId: 'c1', name: 'rule', args: 'pin d3-0' } },
    turnStart(5, 3), userMessage(6, 3, '以后都用英文回答'),
  ]
  const state = fold(events)
  const pinned = state.directives['d3-0']
  assert.equal(pinned.kind, 'pin')
  assert.equal(pinned.status, 'active')
  assert.equal(state.directives['d6-0'].status, 'superseded')
})

test('/rule drop retires a requirement without deleting it', () => {
  const events = [
    turnStart(1, 1),
    turnStart(2, 2), userMessage(3, 2, '以后都用中文回答'),
    { type: 'command/run', seq: 4, time: 4, data: { commandId: 'c1', name: 'rule', args: 'drop d3-0' } },
  ]
  const state = fold(events)
  assert.equal(state.directives['d3-0'].status, 'revoked')
  assert.equal(renderLedger(state, 800).text, '')
})

test('/rule add pins a manually entered requirement', () => {
  const events = [
    turnStart(1, 1),
    { type: 'command/run', seq: 2, time: 2, data: { commandId: 'c1', name: 'rule', args: 'add 以后提交前必须跑测试' } },
  ]
  const state = fold(events)
  const added = state.directives['c2']
  assert.equal(added.authority, 'user-pinned')
  assert.equal(added.topicKey, 'workflow.test-command')
})

test('a requirement whose prompt was replaced is retracted, not left in force', () => {
  const events = [
    turnStart(1, 1),
    turnStart(2, 2), userMessage(3, 2, '以后都用中文回答'),
    // ask-again style: a replacement message covering seq 3.
    userMessage(5, 2, '用英文回答吧', {
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
      sourceEventSeqs: [3],
    }),
  ]
  const state = fold(events)
  assert.equal(state.directives['d3-0'].status, 'retracted')
  assert.equal(renderLedger(state, 800).text.includes('永远'), false)
})

test('ignored events return the same reference', () => {
  const state = emptyState()
  assert.equal(applyEvent(state, { type: 'assistant/message', seq: 1, data: {} }), state)
  assert.equal(applyEvent(state, { type: 'tool/result', seq: 2, data: {} }), state)
})

test('an unchanged ledger renders identical bytes', () => {
  const state = fold(FIXTURE)
  const first = renderLedger(state, 800).text
  const second = renderLedger(fold(FIXTURE), 800).text
  assert.equal(first, second)
  assert.ok(first.includes('[RULE]'))
  assert.ok(first.includes('[BAN]'))
})

test('the budget omits entries explicitly instead of dropping them', () => {
  const events = [turnStart(1, 1)]
  for (let index = 0; index < 20; index += 1) events.push(userMessage(index + 2, 1, `以后第 ${index} 项都要这么做`))
  const state = fold(events)
  const rendered = renderLedger(state, 60)
  assert.ok(rendered.included.length >= 1)
  assert.ok(rendered.omitted.length > 0)
  assert.ok(rendered.text.includes('未列出'))
})

test('/rule list separates the four retirement reasons', () => {
  const state = fold(FIXTURE)
  const text = listLedger(state)
  assert.ok(text.includes('生效中'))
  assert.ok(text.includes('已取代'))
})
