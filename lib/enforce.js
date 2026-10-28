/**
 * The enforceable half: prohibitions the plugin can actually verify.
 *
 * Only `ban` directives carrying a checker reach this module, and only through
 * `ctx.tools.guard()`, which is synchronous and monotonic — no waterfall
 * listener can force-allow what it denied. Everything else stays advisory on
 * purpose: a wrong block costs more trust than a missed reminder.
 *
 * @module directive-ledger/enforce
 */

/**
 * Tools whose path argument names a file the call would CHANGE. Reads are
 * deliberately absent: "don't modify that directory" must not block looking.
 */
const WRITE_PATH_TOOLS = Object.freeze({
  write: ['file_path'],
  edit: ['file_path'],
})

/** Tools whose command string is matched against a forbidden command or path. */
const COMMAND_TOOLS = Object.freeze(['pwsh', 'bash'])

/** Normalize a path or glob for prefix comparison. */
function normalize(value) {
  return String(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Whether a target path falls inside a forbidden root.
 * @param {string} target - the path the tool is about to touch.
 * @param {string} forbidden - the root named by the user.
 * @returns {boolean} true when the target is the root itself or below it.
 */
export function isInside(target, forbidden) {
  const left = normalize(target)
  const right = normalize(forbidden)
  if (right === '') return false
  return left === right || left.startsWith(`${right}/`)
}

/** Render the refusal so the user can see which requirement stopped the call. */
function refusal(directive, detail) {
  return `已被用户要求阻止：${directive.text}（来源：第 ${directive.turn} 轮，#${directive.sourceSeq}）\n${detail}`
}

/**
 * Check one pending tool call against the ledger.
 * @param {object} state - ledger state.
 * @param {{name: string, arguments: unknown}} execution - the pending call.
 * @returns {string|undefined} a refusal reason, or undefined to allow.
 */
export function checkCall(state, execution) {
  const name = String(execution?.name ?? '')
  const args = execution?.arguments
  if (args === null || typeof args !== 'object') return undefined
  const bans = Object.values(state?.directives ?? {}).filter((directive) => directive.status === 'active' && directive.checker !== null)
  if (bans.length === 0) return undefined
  for (const directive of bans) {
    const spec = directive.checker
    if (spec.type === 'forbidden-write') {
      const keys = WRITE_PATH_TOOLS[name]
      if (keys === undefined) continue
      for (const key of keys) {
        const value = args[key]
        if (typeof value !== 'string' || value === '') continue
        if (isInside(value, spec.value)) return refusal(directive, `目标路径：${value}`)
      }
      continue
    }
    if (spec.type === 'forbidden-command') {
      if (!COMMAND_TOOLS.includes(name)) continue
      const command = typeof args.command === 'string' ? args.command : ''
      if (command === '') continue
      if (matchesCommand(command, spec.value)) return refusal(directive, `命令：${command}`)
    }
  }
  return undefined
}

/**
 * Whether a shell command invokes a forbidden program or path.
 *
 * Word-boundary matching keeps "npm" from matching "pnpm", and comparing on
 * normalized separators keeps "D:\prod" from matching "D:\production".
 * @param {string} command - the command line.
 * @param {string} forbidden - a program name or a path.
 * @returns {boolean} true when the command is forbidden.
 */
export function matchesCommand(command, forbidden) {
  const spec = String(forbidden).trim()
  if (spec === '') return false
  if (spec.includes('/') || spec.includes('\\')) {
    return commandMentionsPath(command, spec)
  }
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w.-])${escaped}([^\\w.-]|$)`, 'i').test(command)
}

/**
 * Whether a command line mentions one path or anything below it.
 *
 * A plain substring test would treat "D:\production" as "D:\prod" and block a
 * legitimate command, so the match must end at a path boundary.
 * @param {string} command - the command line.
 * @param {string} spec - the forbidden path.
 * @returns {boolean} true when the command touches the path.
 */
export function commandMentionsPath(command, spec) {
  const haystack = normalize(command)
  const needle = normalize(spec)
  if (needle === '') return false
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const next = haystack[at + needle.length]
    // End of string, a separator, or any delimiter ends the path; a word
    // character or a dash continues it into a different name.
    if (next === undefined || next === '/' || !/[a-z0-9._-]/.test(next)) return true
  }
  return false
}
