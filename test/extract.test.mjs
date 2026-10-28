import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractDirectives, inferTopicKey, normalizePath } from '../lib/extract.js'

test('the design fixture: four requirements across one conversation', () => {
  assert.deepEqual(
    extractDirectives('以后都用中文回答').map((item) => [item.kind, item.topicKey]),
    [['rule', 'output.language']],
  )
  assert.deepEqual(
    extractDirectives('用 npm 装依赖吧').map((item) => [item.kind, item.topicKey]),
    [['decision', 'tool.package-manager']],
  )
  const ban = extractDirectives('不要动 `D:\\prod` 下的任何文件')
  assert.equal(ban.length, 1)
  assert.equal(ban[0].kind, 'ban')
  assert.equal(ban[0].checker.type, 'forbidden-write')
  assert.equal(ban[0].checker.value, 'D:/prod')
  // The clause names two managers: pnpm is requested, npm is forbidden. Both
  // survive, because a prohibition is a different intent from an instruction.
  const switched = extractDirectives('算了，还是用 pnpm，别再提 npm')
  assert.deepEqual(switched.map((item) => item.kind), ['decision', 'ban'])
  assert.equal(switched[1].checker.value, 'npm')
  assert.notEqual(switched[0].topicKey, switched[1].topicKey)
})

test('a question states no requirement', () => {
  assert.deepEqual(extractDirectives('要不要改用 pnpm？'), [])
  assert.deepEqual(extractDirectives('是否必须用中文'), [])
})

test('a prohibition still applies when phrased as a question of policy', () => {
  const found = extractDirectives('一律不要用 npm')
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'ban')
})

test('one message can yield several requirements', () => {
  const found = extractDirectives('以后都用中文。另外测试一律跑 node --test。还有不要改 `D:\\prod`。')
  assert.equal(found.length, 3)
  assert.deepEqual(found.map((item) => item.kind), ['rule', 'rule', 'ban'])
})

test('a scope label is not recorded as the requirement', () => {
  // Observed live: the label became the "requirement" while the actual
  // instruction was cut away with it.
  const found = extractDirectives('对象是：每一轮的对话，不用考虑跨对话')
  assert.equal(found.length, 1)
  assert.equal(found[0].text, '不用考虑跨对话')
})

test('a comma inside one constraint does not split its subject away', () => {
  const found = extractDirectives('一级标题只用于划分真正独立的顶层主题，不得把每个要点都写成一级标题')
  assert.equal(found.length, 1)
  assert.ok(found[0].text.startsWith('一级标题只用于'))
})

test('an enumeration marker is stripped from the recorded text', () => {
  const found = extractDirectives('1、以后提交前必须跑测试')
  assert.equal(found.length, 1)
  assert.equal(found[0].text, '以后提交前必须跑测试')
})

test('paths normalize to a comparison-stable form', () => {
  assert.equal(normalizePath('D:\\prod\\'), 'D:/prod')
  assert.equal(normalizePath('D:/prod'), 'D:/prod')
})

test('a path-specific ban does not share a slot with another directory', () => {
  const first = inferTopicKey('不要动 `D:\\prod`', 'ban')
  const second = inferTopicKey('不要动 `D:\\secrets`', 'ban')
  assert.notEqual(first, second)
})

test('the same requirement phrased twice keeps one topic', () => {
  const left = inferTopicKey('以后都用中文回答', 'rule')
  const right = inferTopicKey('从现在起必须用中文回答', 'rule')
  assert.equal(left, right)
})

test('an unclassified requirement still gets a stable key', () => {
  const clause = '每次先给我看 diff 再说'
  assert.equal(inferTopicKey(clause, 'rule'), inferTopicKey(clause, 'rule'))
})
