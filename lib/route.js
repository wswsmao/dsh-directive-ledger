/**
 * The one write path that reaches the ledger from the browser.
 *
 * A delete button is tempting to implement as "hide this row in the UI", but the
 * ledger is derived from the session log: anything that is not in the log comes
 * back on the next reload. So the route below does not mutate state at all — it
 * runs the existing `/rule drop` command, which appends a `command/run` event
 * and lets the normal fold retire the directive. The UI and the model therefore
 * observe the same removal, and the removal survives a restart.
 *
 * @module directive-ledger/route
 */

/** Every endpoint lives below this prefix. */
export const ROUTE_PREFIX = '/plugins/directive-ledger'

/** Request bodies are two short strings; anything larger is refused. */
const MAX_BODY_BYTES = 16 * 1024

/** Send one JSON response. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Read one bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>>} parsed object; `{}` when empty.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Mount the removal route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context with `webServer`, `connection`, `agents`, `commands`.
 */
export function registerRoute(ctx) {
  /** Resolve one directive id to a session and command target. */
  async function drop(request) {
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
    const directiveId = typeof request.directiveId === 'string' ? request.directiveId.trim() : ''
    if (sessionId === '' || directiveId === '') throw new RouteError(400, 'sessionId 和 directiveId 都必须给出。')
    // A directive id is minted by this plugin; anything else is a malformed call
    // rather than a lookup that could accidentally match a neighbouring entry.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(directiveId)) throw new RouteError(400, 'directiveId 格式不正确。')
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new RouteError(409, '该会话当前未运行，无法修改台账。请先回到该会话再删除。')
    const execution = await ctx.commands.execute(
      agent,
      `/rule drop ${directiveId}`,
      [],
      new AbortController().signal,
    )
    if (execution === undefined) throw new RouteError(500, '当前会话没有 /rule 命令，无法删除。')
    if (execution.result.kind !== 'success') {
      throw new RouteError(409, execution.result.text ?? '删除失败。')
    }
    return { removed: directiveId, message: execution.result.text }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    async handler(req, res) {
      // Same trust fence every other plugin route uses: a request that did not
      // come through this Host's authenticated channel is rejected before any
      // session lookup happens.
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://directive-ledger.invalid')
      const rest = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : ''
      try {
        if (req.method !== 'POST') throw new RouteError(405, '只支持 POST。')
        if (rest !== '/drop') throw new RouteError(404, '未知接口。')
        const body = await readJsonBody(req)
        sendJson(res, 200, { ok: true, ...(await drop(body)) })
      } catch (error) {
        const status = error instanceof RouteError ? error.status : 500
        const message = error instanceof Error ? error.message : String(error)
        if (status >= 500) ctx.logger.warn(`[directive-ledger] ${message}`)
        sendJson(res, status, { ok: false, code: error?.code ?? 'error', message })
      }
    },
  }), 'directive-ledger: removal route')
}

/** A failure the route reports with a specific status. */
class RouteError extends Error {
  constructor(status, message, code = 'error') {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.code = code
  }
}
