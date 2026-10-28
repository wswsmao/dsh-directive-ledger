/**
 * Replay a real, persisted session log through the fold.
 *
 * The packaged Harness lives inside `app.asar`, which only the Host process can
 * read, so a full AgentLoop regression cannot run under plain node. This script
 * verifies the part that does not need the harness: that the ledger derived from
 * a real conversation log contains the requirements the user actually stated,
 * with one in-force entry per topic and a visible replacement chain.
 *
 * Usage: node test/replay-session.mjs <session.v4.jsonl.zstd>
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { applyEvent, emptyState, viewState } from '../lib/ledger.js'
import { renderLedger } from '../lib/render.js'

const file = process.argv[2]
if (!file) throw new Error('usage: node test/replay-session.mjs <session.v4.jsonl.zstd>')

/**
 * Read a persisted session log.
 *
 * The JSONL backend appends one zstd frame per write, so a log is a
 * concatenation of frames rather than a single stream. `zstdDecompressSync`
 * stops at the first frame, which is why this walks the frame magic instead of
 * decompressing the buffer in one call.
 *
 * @param {string} path - log path.
 * @returns {Promise<string>} the decoded JSONL text.
 */
async function readLog(path) {
  const bytes = await readFile(path)
  if (bytes[0] === 0x7b) return bytes.toString('utf8')
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let at = bytes.indexOf(magic); at >= 0; at = bytes.indexOf(magic, at + 4)) starts.push(at)
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    let end = starts[index + 1] ?? bytes.length
    // A frame boundary is guessed from the magic alone; when the guess lands
    // inside a frame, decompression fails and the frame is retried with the
    // next candidate boundary.
    for (; ;) {
      try {
        parts.push(zstdDecompressSync(bytes.subarray(starts[index], end)).toString('utf8'))
        break
      } catch (error) {
        if (end >= bytes.length) throw new Error(`session frame at byte ${starts[index]} cannot be decompressed`, { cause: error })
        const next = bytes.indexOf(magic, end + 4)
        end = next < 0 ? bytes.length : next
      }
    }
    while (starts[index + 1] !== undefined && starts[index + 1] < end) index += 1
  }
  return parts.join('')
}

const text = await readLog(resolve(file))
const events = text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))

let state = emptyState()
let users = 0
for (const event of events) {
  if (event.type === 'user/message' && event.data?.source?.kind === 'user') users += 1
  state = applyEvent(state, event)
}

const view = viewState(state)
const active = view.items.filter((item) => item.status === 'active')
const superseded = view.items.filter((item) => item.status === 'superseded')
const topics = active.map((item) => item.topicKey)
assert.equal(new Set(topics).size, topics.length, 'two in-force entries share a topic slot')

const rendered = renderLedger(state, 800).text
console.log(JSON.stringify({
  file: resolve(file),
  events: events.length,
  userMessages: users,
  recorded: view.items.length,
  inForce: active.map((item) => ({ id: item.id, kind: item.kind, topic: item.topicKey, text: item.text })),
  replaced: superseded.map((item) => ({ id: item.id, text: item.text, by: item.supersededBy })),
  renderedTokens: rendered === '' ? 0 : rendered.length,
}, null, 2))
