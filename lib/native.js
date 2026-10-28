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
  const entry = process.env.DSH_RUNTIME_ENTRY ?? process.argv[1]
  if (!entry || !isAbsolute(entry)) throw new Error('Harness runtime entry is unavailable')
  const require = createRequire(entry)
  let resolved
  try {
    resolved = require.resolve(name)
  } catch (error) {
    // The packaged Harness lives inside `app.asar`, which only the Host process
    // can read. Running this module under plain node is therefore expected to
    // fail here; name the real cause instead of surfacing MODULE_NOT_FOUND.
    throw new Error(`cannot resolve "${name}" from the Harness entry "${entry}"; run this code inside the Harness (or point DSH_RUNTIME_ENTRY at a resolvable entry)`, { cause: error })
  }
  return import(pathToFileURL(resolved).href)
}
