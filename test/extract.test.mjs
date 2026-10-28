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
  // The clause names two managers; the forbidden one is the one after "别再",
  // not the one the user just switched to.
  const switched = extractDirectives('算了，还是用 pnpm，别再提 npm')
  assert.equal(switched.length, 1)
  assert.equal(switched[0].kind, 'ban')
  assert.equal(switched[0].topicKey, 'tool.package-manager')
  assert.equal(switched[0].checker.value, 'npm')
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
