/**
 * Native runtime regression: mount the real AgentLoop, the real projection
 * registry, the real system-prompt registry, and the real tool runtime, then
 * observe what this plugin actually makes the model see and what it actually
 * blocks. The model is an offline adapter, so nothing reaches a provider.
 *
 * Run with: node test/runtime-regression.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nativePackage } from '../lib/native.js'
import { apply as mountLedger } from '../index.js'

const { Context } = await nativePackage('@deepseek-ai/cordis')
const { default: SessionStore } = await nativePackage('@deepseek-ai/dsh-session')
const { default: AgentRegistry } = await nativePackage('@deepseek-ai/dsh-agent')
const { LlmRuntime, LlmAdapter, createUserMessage } = await nativePackage('@deepseek-ai/dsh-llm')
const { default: SessionProjectionRegistry } = await nativePackage('@deepseek-ai/dsh-session-projection')
const { default: SystemPrompt } = await nativePackage('@deepseek-ai/dsh-system-prompt')
const { default: ToolRuntime } = await nativePackage('@deepseek-ai/dsh-tools')
const { default: CommandRuntime } = await nativePackage('@deepseek-ai/dsh-commands')
const JsonlPersistence = await nativePackage('@deepseek-ai/dsh-session-persistence-jsonl')
const { default: AgentLoop } = await nativePackage('@deepseek-ai/dsh-agent-loop')

/** Join one message's text blocks. */
function textOf(message) {
  return (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-directive-ledger-test-'))
const root = new Context()
const fibers = []
const snapshots = []
const checks = []

/** Mount one plugin and wait for it to settle. */
async function mount(plugin, config = {}) {
  const fiber = root.plugin(plugin, config)
  fibers.push(fiber)
  await fiber.await()
  return fiber
}

class OfflineModel extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 100000 } }
  }

  async *stream(request) {
    snapshots.push(structuredClone(request.messages))
    const answer = 'ok'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

try {
  await mount(SessionStore)
  await mount(AgentRegistry)
  await mount(LlmRuntime)
  await mount(SessionProjectionRegistry)
  await mount(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: true })
  await mount(ToolRuntime, { mode: 'native' })
  await mount(CommandRuntime)
  await mount(JsonlPersistence, { root: directory, compression: 'none' })
  await mount(AgentLoop, { agents: [], maxParallelToolCalls: 1 })

  root.llm.registerAdapter(['ledger-offline-test'], new OfflineModel())
  const fiber = root.plugin({ name: 'directive-ledger-test', apply: mountLedger, inject: ['sessionProjections', 'systemPrompt', 'tools', 'commands', 'agents'] }, {
    budgetTokens: 800,
    reminderMode: 'auto',
    enforce: 'guard',
  })
  fibers.push(fiber)
  await fiber.await()

  const handle = await root.agents.create({
    sessionId: 'directive-ledger-native-fixture',
    meta: { cwd: directory },
    agentOptions: { provider: 'ledger-offline-test', model: 'fixture' },
  })
  const send = async (text) => {
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await root.sessions.flush(handle.agent.session)
  }

  // --- the standing block reaches the model -------------------------------
  await send('以后都用中文回答')
  const first = snapshots.at(-1).map(textOf).join('\n---\n')
  assert.ok(first.includes('仍然生效的用户要求'), 'the standing block is missing from the request')
  assert.ok(first.includes('[RULE] 以后都用中文回答'), 'the requirement itself is missing')
  checks.push('standing block reaches the model')

  await send('用 npm 装依赖吧')
  const second = snapshots.at(-1).map(textOf).join('\n---\n')
  assert.ok(second.includes('[DEC] 用 npm 装依赖吧'), 'a plain package choice was not recorded')
  assert.ok(second.includes('[RULE] 以后都用中文回答'), 'an earlier requirement was dropped')
  checks.push('requirements accumulate instead of being forgotten')

  // --- a newer requirement replaces the older one -------------------------
  await send('算了，还是用 pnpm，别再提 npm')
  const third = snapshots.at(-1).map(textOf).join('\n---\n')
  assert.ok(third.includes('pnpm'), 'the replacement is missing')
  assert.ok(!third.includes('[DEC] 用 npm 装依赖吧'), 'the replaced requirement is still presented as in force')
  checks.push('a newer requirement removes the older one from the prompt')

  // --- the pre-step reminder names the supersession -----------------------
  const reminder = snapshots.at(-1).flat().map(textOf).find((text) => text.includes('取代了旧要求'))
  assert.ok(reminder !== undefined, 'the supersession reminder was not injected')
  assert.ok(reminder.includes('npm'), 'the reminder does not name the replaced requirement')
  checks.push('the pre-step reminder fires on supersession')

  // --- a machine-checkable prohibition blocks the call --------------------
  await send('不要动 `D:\\prod` 下的任何文件')
  const blocked = await root.tools.execute({
    callId: 'call-blocked-1',
    name: 'write',
    arguments: { file_path: 'D:\\prod\\report.json', content: '{}' },
    agent: handle.agent,
    signal: new AbortController().signal,
  })
  assert.equal(blocked.isError, true, 'the forbidden write was not blocked')
  assert.ok(JSON.stringify(blocked.content).includes('第 6 轮') || JSON.stringify(blocked.content).includes('turn'), 'the refusal does not cite its source')
  checks.push('a forbidden write is blocked by the guard')

  const allowed = await root.tools.execute({
    callId: 'call-allowed-1',
    name: 'write',
    arguments: { file_path: join(directory, 'report.json'), content: '{}' },
    agent: handle.agent,
    signal: new AbortController().signal,
  })
  assert.equal(allowed.isError, false, 'a legitimate write was blocked')
  checks.push('a write outside the forbidden root still runs')

  // --- /rule reads the same ledger the model saw --------------------------
  const listed = await root.commands.execute(handle.agent, '/rule list', [], new AbortController().signal)
  assert.equal(listed.result.kind, 'success')
  assert.ok(listed.result.text.includes('生效中'), 'the listing has no in-force group')
  assert.ok(listed.result.text.includes('已取代'), 'the listing does not show the replaced entry')
  checks.push('/rule list reports the same ledger')

  // --- the same log folds to the same ledger after a reload ----------------
  const state = root.sessionProjections.stateOf(handle.agent.session, 'directiveLedger')
  const active = Object.values(state.directives).filter((directive) => directive.status === 'active')
  const topics = active.map((directive) => directive.topicKey)
  assert.equal(new Set(topics).size, topics.length, 'two in-force entries share a topic slot')
  checks.push('one in-force entry per topic after the whole conversation')

  console.log(JSON.stringify({ passed: true, checks }, null, 2))
} finally {
  for (const fiber of fibers.reverse()) try { await fiber.dispose() } catch { /* already unloaded */ }
  await rm(directory, { recursive: true, force: true })
}
