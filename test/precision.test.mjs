import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classify, extractDirectives, isQuestion } from '../lib/extract.js'

/**
 * Regressions from replaying a real 215-message session. Every string here was
 * actually recorded as a "standing requirement" by an earlier revision, and each
 * one is a report, a question, or a fragment — not an instruction.
 */
const FALSE_POSITIVES = [
  '这个问题一定要解决掉',
  '看你几乎每次回答问题都清理残留，得看一下为何，优化一下',
  '怎么从机制上让每次端到端运行完，无论是定时任务，还是跟你对话，都能把日报的链接发出来',
  '“我每次端到端验证也会给你发微信消息”这是我需要的啊',
  '不用你核实，我的意思是，我不加这么多的限定，不指导你怎么看的情况下，你是不是也能筛选',
  '我没说你就禁止端到端测试',
  '2 大模型把列表做个初筛，得到初筛列表，避免全量的检索结果都要打开并且让模型分析一遍',
  '我这里有个疑惑，你会把微信本身的点赞数浏览数之类的数据作为裁决指标吗，你觉得要不要引入',
  '感觉也没啥意义，也就是说聊了这么久，你觉得这些已经够了？',
  '先停下来吧，我看了你执行流程，你思维链显示先等 phaseA 完成',
]

for (const text of FALSE_POSITIVES) {
  test(`not a requirement: ${text.slice(0, 24)}…`, () => {
    assert.deepEqual(extractDirectives(text), [])
  })
}

test('a real instruction still gets through', () => {
  const found = extractDirectives('每次修改需要有 git commit')
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'rule')
})

test('a short prohibition missing its head still gets through', () => {
  const found = extractDirectives('注：不要限制数量，有多少返回多少')
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'ban')
  assert.equal(found[0].text, '不要限制数量，有多少返回多少')
})

test('a plain decision still gets through', () => {
  const found = extractDirectives('改成中午12:10触发')
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'decision')
})

test('a question particle alone is enough to make it a question', () => {
  assert.equal(isQuestion('然后才是一个个文章打开吗'), true)
  assert.equal(isQuestion('每次修改需要有 git commit'), false)
})

test('a clause of twenty characters with a mid-sentence marker is still prose', () => {
  // The marker is present but the clause is a narration; length alone must not
  // promote it.
  assert.equal(classify('我觉得这个方案一定要再想想'), undefined)
})

test('opening with a marker beats a long tail', () => {
  const found = extractDirectives('不要继续执行误导 agent，要有明确的输出')
  assert.equal(found.length, 1)
  assert.equal(found[0].kind, 'ban')
})
