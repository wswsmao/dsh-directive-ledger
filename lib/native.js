/**
 * Resolve a package from the running Harness instead of this linked checkout.
 *
 * A profile plugin is installed by symlink and declares no dependencies, so
 * `import 'zod'` would resolve against the plugin directory and fail.
 *
 * @module directive-ledger/native
 */

import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Import one package the Harness itself ships.
 * @param {string} name - package specifier.
 * @returns {Promise<any>} the package namespace.
 */
export async function nativePackage(name) {
  const entry = process.argv[1]
  if (!entry || !isAbsolute(entry)) throw new Error('Harness runtime entry is unavailable')
  const require = createRequire(entry)
  return import(pathToFileURL(require.resolve(name)).href)
}
