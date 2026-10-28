import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROUTE_PREFIX, registerRoute } from '../lib/route.js'

/** Collect one registration out of a fake context. */
function makeContext({ agents = new Map(), commandResult } = {}) {
  const registered = []
  const executed = []
  const ctx = {
    webServer: {
      register: (route) => {
        registered.push(route)
        return () => {}
      },
    },
    connection: {
      // Every request in this file is treated as authenticated unless a test
      // overrides it; the trust fence has its own case below.
      requestRejection: () => undefined,
    },
    agents: { get: (id) => agents.get(id) },
    commands: {
      execute: async (agent, line, attachments, signal) => {
        executed.push({ sessionId: agent.id, line, signal })
        return commandResult === undefined ? undefined : commandResult
      },
    },
    logger: { warn: () => {} },
    effect: (factory) => factory(),
  }
  return { ctx, registered, executed }
}

/** Build one request/response pair for the route handler. */
function call(handler, { method = 'POST', path = `${ROUTE_PREFIX}/drop`, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const listeners = {}
  const req = {
    method,
    url: path,
    on: (event, callback) => {
      listeners[event] = callback
      return req
    },
    destroy: () => {},
  }
  let statusCode = 0
  let payload = ''
  const res = {
    setHeader: () => {},
    end: (value) => {
      payload = value ?? ''
    },
    get statusCode() {
      return statusCode
    },
    set statusCode(value) {
      statusCode = value
    },
  }
  const done = handler(req, res)
  // Feed the body after the handler attached its listeners.
  for (const chunk of chunks) listeners.data?.(chunk)
  listeners.end?.()
  return done.then(() => ({ status: statusCode, json: payload === '' ? null : JSON.parse(payload) }))
}

test('the route is mounted under the plugin prefix', () => {
  const { ctx, registered } = makeContext()
  registerRoute(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].path, ROUTE_PREFIX)
  assert.equal(registered[0].kind, 'prefix')
})

test('a removal runs the logged /rule drop command', async () => {
  const agent = { id: 'session-1' }
  const { ctx, registered, executed } = makeContext({
    agents: new Map([['session-1', agent]]),
    commandResult: { commandId: 'c1', result: { kind: 'success', text: '已撤销 [d7-0] 不要动 D:/prod' } },
  })
  registerRoute(ctx)
  const result = await call(registered[0].handler, {
    body: { sessionId: 'session-1', directiveId: 'd7-0' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.removed, 'd7-0')
  // The ledger is derived from the log, so the removal must go through the
  // command that appends a command/run event — not through a direct mutation.
  assert.deepEqual(executed.map((entry) => entry.line), ['/rule drop d7-0'])
})

test('an unloaded session is refused instead of silently doing nothing', async () => {
  const { ctx, registered } = makeContext()
  registerRoute(ctx)
  const result = await call(registered[0].handler, {
    body: { sessionId: 'missing', directiveId: 'd7-0' },
  })
  assert.equal(result.status, 409)
  assert.equal(result.json.ok, false)
  assert.match(result.json.message, /未运行/)
})

test('a malformed directive id never reaches the command layer', async () => {
  const { ctx, registered, executed } = makeContext({
    agents: new Map([['session-1', { id: 'session-1' }]]),
  })
  registerRoute(ctx)
  const result = await call(registered[0].handler, {
    body: { sessionId: 'session-1', directiveId: '../../etc/passwd' },
  })
  assert.equal(result.status, 400)
  assert.equal(executed.length, 0)
})

test('a missing command definition is reported, not swallowed', async () => {
  const { ctx, registered } = makeContext({
    agents: new Map([['session-1', { id: 'session-1' }]]),
    commandResult: undefined,
  })
  registerRoute(ctx)
  const result = await call(registered[0].handler, {
    body: { sessionId: 'session-1', directiveId: 'd7-0' },
  })
  assert.equal(result.status, 500)
  assert.match(result.json.message, /\/rule/)
})

test('a failed command keeps the host refusal text', async () => {
  const { ctx, registered } = makeContext({
    agents: new Map([['session-1', { id: 'session-1' }]]),
    commandResult: { commandId: 'c1', result: { kind: 'error', text: '没有找到条目 "zzz"。' } },
  })
  registerRoute(ctx)
  const result = await call(registered[0].handler, {
    body: { sessionId: 'session-1', directiveId: 'zzz' },
  })
  assert.equal(result.status, 409)
  assert.match(result.json.message, /没有找到条目/)
})

test('the trust fence rejects an unauthenticated request before any lookup', async () => {
  const { ctx, registered, executed } = makeContext({
    agents: new Map([['session-1', { id: 'session-1' }]]),
  })
  ctx.connection.requestRejection = () => 401
  registerRoute(ctx)
  const result = await call(registered[0].handler, {
    body: { sessionId: 'session-1', directiveId: 'd7-0' },
  })
  assert.equal(result.status, 401)
  assert.equal(result.json, null)
  assert.equal(executed.length, 0)
})

test('a non-POST method is refused', async () => {
  const { ctx, registered } = makeContext()
  registerRoute(ctx)
  const result = await call(registered[0].handler, { method: 'GET', path: `${ROUTE_PREFIX}/drop` })
  assert.equal(result.status, 405)
})

test('an unknown sub-route is refused', async () => {
  const { ctx, registered } = makeContext()
  registerRoute(ctx)
  const result = await call(registered[0].handler, { path: `${ROUTE_PREFIX}/nuke`, body: {} })
  assert.equal(result.status, 404)
})
