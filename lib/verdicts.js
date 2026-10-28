/**
 * Durable verdict cache.
 *
 * A verdict is the semantic judgement of one user message: whether it states a
 * standing requirement, which kind, and what it supersedes. Judging costs a model
 * call, so the result is keyed by the message text itself rather than by position:
 * the same sentence in two sessions is judged once, and replaying a log never
 * re-judges anything.
 *
 * The cache is an accelerator with a correct fallback, never the only record. If
 * it is lost, messages fall back to the deterministic rules and the panel marks
 * them as unjudged — degraded, never silently wrong.
 *
 * @module directive-ledger/verdicts
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Bumped whenever the judgement prompt changes, so stale verdicts are not reused. */
export const JUDGE_PROMPT_VERSION = 1

/** Bounded cache: oldest keys are dropped past this count. */
const MAX_VERDICTS = 2000

/**
 * Stable identity of one message's judgement.
 * @param {string} text - the user message text.
 * @returns {string} cache key.
 */
export function verdictKey(text) {
  const normalized = String(text).replace(/\s+/g, ' ').trim()
  return createHash('sha1').update(`${JUDGE_PROMPT_VERSION}\u0000${normalized}`).digest('hex')
}

/**
 * Open the verdict cache.
 *
 * Loading is best-effort: a corrupt file is set aside rather than thrown, because
 * losing judgements degrades precision while refusing to start loses the plugin.
 *
 * @param {string} directory - where `verdicts.json` lives.
 * @param {{ warn?: (message: string) => void }} [options] - diagnostics sink.
 * @returns {{get: Function, set: Function, size: Function, close: Function}} cache handle.
 */
export function openVerdicts(directory, options = {}) {
  const warn = options.warn ?? (() => {})
  const file = join(directory, 'verdicts.json')
  /** @type {Map<string, object>} */
  const entries = new Map()
  let dirty = false
  let timer

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.entries !== null && typeof parsed.entries === 'object') {
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (value !== null && typeof value === 'object' && typeof value.kind === 'string') entries.set(key, value)
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`verdict cache unreadable, starting empty: ${error.message}`)
  }

  /** Persist through a temp file so a crash cannot leave a half-written cache. */
  function flush() {
    timer = undefined
    if (!dirty) return
    dirty = false
    try {
      mkdirSync(directory, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: JUDGE_PROMPT_VERSION, entries: Object.fromEntries(entries) }), 'utf8')
      renameSync(temporary, file)
    } catch (error) {
      warn(`could not persist verdict cache: ${error.message}`)
    }
  }

  /** Coalesce bursts of writes into one flush. */
  function schedule() {
    dirty = true
    if (timer !== undefined) return
    timer = setTimeout(flush, 250)
    if (typeof timer.unref === 'function') timer.unref()
  }

  return {
    /** @param {string} key - verdict cache key. */
    get: (key) => entries.get(key),
    /**
     * @param {string} key - verdict cache key.
     * @param {object} verdict - judgement to remember.
     */
    set: (key, verdict) => {
      entries.set(key, verdict)
      // A Map preserves insertion order, so the first keys are the oldest.
      while (entries.size > MAX_VERDICTS) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      schedule()
    },
    size: () => entries.size,
    close: () => {
      if (timer !== undefined) clearTimeout(timer)
      flush()
    },
  }
}

/**
 * Resolve a directory for plugin-owned data.
 * @param {string|undefined} configured - the row's `dataDir`, when set.
 * @returns {string} absolute directory.
 */
export function resolveDataDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(home.trim(), 'directive-ledger')
  return join(process.cwd(), '.runtime', 'directive-ledger')
}
