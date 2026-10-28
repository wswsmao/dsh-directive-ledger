import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkCall, isInside, matchesCommand } from '../lib/enforce.js'
import { emptyState } from '../lib/ledger.js'

/** Build a minimal ledger holding one enforceable ban. */
function ledgerWith(checker, overrides = {}) {
  const directive = {
    id: 'd1',
    sourceSeq: 7,
    turn: 14,
    quote: '不要动 D:\\prod',
    text: '不要动 `D:\\prod` 下的任何文件',
    kind: 'ban',
    topicKey: `path.forbidden-write:${checker.value}`,
    authority: 'literal-anchored',
    status: 'active',
    supersedes: [],
    supersededBy: null,
    checker,
    ...overrides,
  }
  return { ...emptyState(), directives: { d1: directive }, order: ['d1'], revision: 1 }
}

test('a write inside the forbidden root is refused and names its source turn', () => {
  const state = ledgerWith({ type: 'forbidden-write', value: 'D:/prod' })
  const reason = checkCall(state, { name: 'write', arguments: { file_path: 'D:\\prod\\a.json', content: '{}' } })
  assert.ok(reason !== undefined)
  assert.ok(reason.includes('第 14 轮'))
  assert.ok(reason.includes('#7'))
})

test('a write outside the forbidden root is allowed', () => {
  const state = ledgerWith({ type: 'forbidden-write', value: 'D:/prod' })
  assert.equal(checkCall(state, { name: 'write', arguments: { file_path: 'D:\\prod-backup\\a.json' } }), undefined)
  assert.equal(checkCall(state, { name: 'write', arguments: { file_path: 'D:\\work\\a.json' } }), undefined)
})

test('reading the forbidden root is still allowed', () => {
  const state = ledgerWith({ type: 'forbidden-write', value: 'D:/prod' })
  assert.equal(checkCall(state, { name: 'read', arguments: { file_path: 'D:\\prod\\a.json' } }), undefined)
  assert.equal(checkCall(state, { name: 'glob', arguments: { path: 'D:\\prod', pattern: '**/*.ts' } }), undefined)
})

test('a tool whose arguments are not an object cannot be checked and is allowed', () => {
  const state = ledgerWith({ type: 'forbidden-write', value: 'D:/prod' })
  assert.equal(checkCall(state, { name: 'write', arguments: null }), undefined)
  assert.equal(checkCall(state, { name: 'write', arguments: 'D:\\prod\\a.json' }), undefined)
})

test('a retired ban stops blocking', () => {
  const state = ledgerWith({ type: 'forbidden-write', value: 'D:/prod' }, { status: 'superseded' })
  assert.equal(checkCall(state, { name: 'write', arguments: { file_path: 'D:\\prod\\a.json' } }), undefined)
})

test('a forbidden command is matched on word boundaries', () => {
  const state = ledgerWith({ type: 'forbidden-command', value: 'npm' })
  assert.ok(checkCall(state, { name: 'pwsh', arguments: { command: 'npm install' } }) !== undefined)
  assert.equal(checkCall(state, { name: 'pwsh', arguments: { command: 'pnpm install' } }), undefined)
  assert.equal(checkCall(state, { name: 'pwsh', arguments: { command: 'echo npm-ish' } }), undefined)
})

test('a forbidden path is matched inside a command only below the root', () => {
  assert.equal(matchesCommand('cp a.json D:\\prod\\a.json', 'D:/prod'), true)
  assert.equal(matchesCommand('cp a.json D:\\production\\a.json', 'D:/prod'), false)
})

test('path containment is separator- and case-insensitive', () => {
  assert.equal(isInside('D:\\PROD\\x', 'd:/prod'), true)
  assert.equal(isInside('D:/prod', 'D:/prod/'), true)
  assert.equal(isInside('D:/prodigal', 'D:/prod'), false)
  assert.equal(isInside('anything', ''), false)
})

test('a call without an agent scope is never guessed at', () => {
  const state = ledgerWith({ type: 'forbidden-write', value: 'D:/prod' })
  assert.equal(checkCall(state, { name: 'write', arguments: { file_path: 'D:\\prod\\a.json' } }).length > 0, true)
})
