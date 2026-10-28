/**
 * Smoke test for the browser half.
 *
 * The module contract is a `window.__ModuleLoader__.load({id, factory})` call
 * whose factory returns `{ inject, apply }`. This runs that contract under a
 * minimal fake loader, then exercises the component the way the host would:
 * register into a slot, render it, and assert the visible output. It cannot
 * prove how the page looks, but it does prove the bundle parses, registers, and
 * renders — the failures that otherwise only appear as a blank dock.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'client.js'), 'utf8')
const require = createRequire(import.meta.url)

/** Minimal React stand-in: enough for createElement and hooks. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useMemo: (compute) => compute(),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/**
 * Find every element in a tree matching a predicate.
 *
 * The removal button has no visible text (its label is on `aria-label`), so
 * reading rendered strings cannot prove it exists — the tree has to be walked.
 * Function elements are expanded the same way the host would render them,
 * otherwise a button produced inside a child component is invisible here.
 *
 * @param {unknown} node - element tree.
 * @param {(element: {type: unknown, props: any}) => boolean} predicate - matcher.
 * @returns {Array<{type: unknown, props: any}>} matches.
 */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  if (typeof node.type === 'function') {
    findAll(node.type(node.props), predicate, found)
    return found
  }
  const children = node.props?.children ?? []
  for (const child of Array.isArray(children) ? children : [children]) findAll(child, predicate, found)
  return found
}

/** Render a tree to a string so assertions can read the visible text. */
function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  // The host renders React elements; a function element is invoked with its
  // props, which is what makes this a real render rather than a shape check.
  if (typeof node.type === 'function') return render(node.type(node.props))
  const children = node.props?.children ?? []
  const inner = (Array.isArray(children) ? children : [children]).map(render).join('')
  return inner
}

/** Load the bundle under a fake loader and return its plugin object. */
function loadPlugin() {
  let registered
  const window = {
    __ModuleLoader__: {
      load: (definition) => {
        registered = definition
      },
    },
  }
  const factory = new Function('window', 'require', source)
  factory(window, (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require("${name}")`)
  })
  assert.ok(registered !== undefined, 'the bundle did not call window.__ModuleLoader__.load')
  assert.equal(registered.id, '@local/dsh-directive-ledger')
  return registered.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require("${name}")`)
  })
}

/** Stand-in locale service with the bundle's own dictionaries. */
function makeContext() {
  const dictionaries = {}
  const registrations = []
  const ctx = {
    locale: {
      register: (ns, dicts) => {
        dictionaries[ns] = dicts
        return () => {}
      },
      bind: (ns) => (key, params) => {
        const dict = dictionaries[ns]?.zh ?? {}
        const template = dict[key] ?? key
        return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
      },
    },
    slots: {
      inject: (slot, callback) => {
        ctx.slots.__slot = slot
        callback()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (factory) => factory(),
    __registrations: registrations,
  }
  return ctx
}

/** The wire value the host would serve for the design fixture. */
const FIXTURE_VIEW = {
  revision: 3,
  injected: 3,
  items: [
    { id: 'd3-0', text: '以后都用中文回答', kind: 'rule', topicKey: 'output.language', status: 'active', sourceSeq: 3, turn: 2, authority: 'user-stated', supersedes: [], supersededBy: null, enforceable: false, injected: true },
    { id: 'd5-0', text: '用 npm 装依赖吧', kind: 'decision', topicKey: 'tool.package-manager', status: 'superseded', sourceSeq: 5, turn: 9, authority: 'user-stated', supersedes: [], supersededBy: 'd9-0', enforceable: false, injected: false },
    { id: 'd7-0', text: '不要动 `D:\\prod`', kind: 'ban', topicKey: 'ban.path.forbidden-write:D:/prod', status: 'active', sourceSeq: 7, turn: 14, authority: 'literal-anchored', supersedes: [], supersededBy: null, enforceable: true, injected: true },
    { id: 'd9-0', text: '算了，还是用 pnpm', kind: 'decision', topicKey: 'tool.package-manager', status: 'active', sourceSeq: 9, turn: 21, authority: 'user-stated', supersedes: ['d5-0'], supersededBy: null, enforceable: false, injected: true },
  ],
}

test('the bundle registers one dock entry into the composer zone', () => {
  const plugin = loadPlugin()
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  const ctx = makeContext()
  plugin.apply(ctx)
  assert.equal(ctx.slots.__slot, 'conversation.input.dock')
  assert.equal(ctx.__registrations.length, 1)
  const { options } = ctx.__registrations[0]
  assert.equal(options.name, 'conversation.input.dock')
  assert.equal(options.id, 'directive-ledger')
})

test('the dock lists in-force requirements and marks the replaced one', () => {
  const plugin = loadPlugin()
  const ctx = makeContext()
  plugin.apply(ctx)
  const render_ = ctx.__registrations[0].component
  const t = ctx.locale.bind('directive-ledger')
  const tree = render_({ useProjection: (key) => (key === 'directiveLedger' ? FIXTURE_VIEW : undefined), t })
  const text = render(tree)
  assert.ok(text.includes('以后都用中文回答'), 'an in-force requirement is missing')
  assert.ok(text.includes('算了，还是用 pnpm'), 'the replacement is missing')
  assert.ok(text.includes('不要动'), 'the prohibition is missing')
  assert.ok(!text.includes('用 npm 装依赖吧'), 'a replaced requirement is shown while collapsed')
})

test('the dock renders nothing for an empty ledger', () => {
  const plugin = loadPlugin()
  const ctx = makeContext()
  plugin.apply(ctx)
  const component = ctx.__registrations[0].component
  const t = ctx.locale.bind('directive-ledger')
  const tree = component({ useProjection: () => ({ revision: 0, injected: 0, items: [] }), t })
  assert.equal(render(tree), '', 'an empty ledger must render no DOM')
})

test('the dock survives a projection that has not arrived yet', () => {
  const plugin = loadPlugin()
  const ctx = makeContext()
  plugin.apply(ctx)
  const component = ctx.__registrations[0].component
  const t = ctx.locale.bind('directive-ledger')
  assert.equal(render(component({ useProjection: () => undefined, t })), '')
})

test('the dock aligns itself to the composer card instead of spanning the column', () => {
  // The regression this guards: the card rendered full-width while the input box
  // stayed centred and capped, so the card visually overhung the box below it.
  const start = source.indexOf('const CSS = `')
  const css = source.slice(start, source.indexOf('`', start + 'const CSS = `'.length))
  assert.match(css, /\.dld-dock\s*\{/, 'the dock rule is missing')
  assert.match(css, /max-width:\s*var\(--dsh-composer-card-max-width\)/, 'the card must use the composer width cap')
  assert.match(css, /margin:\s*0 auto/, 'the card must be centred like the composer')
  assert.match(css, /--dsh-composer-side-clearance/, 'the card must subtract the composer side clearance')
  assert.match(css, /box-sizing:\s*border-box/, 'border-box keeps the padding inside the cap')
  // The card FRAME must not hard-code a pixel width, or it stops following the
  // composer on resize. Inner controls (an icon button) legitimately have one, so
  // the check is scoped to the `.dld-dock` rule itself.
  const dockRule = css.slice(css.indexOf('.dld-dock {'), css.indexOf('}', css.indexOf('.dld-dock {')))
  assert.doesNotMatch(dockRule, /\bwidth:\s*\d+px/, 'the dock frame must not hard-code a pixel width')
})

/** Render the dock with the fixture ledger and a live session id. */
function renderDock(options = {}) {
  // Distinguish "not supplied" from "explicitly no session": a default parameter
  // would turn `{sessionId: undefined}` back into a live session and hide the
  // very case this helper is used to test.
  const sessionId = Object.hasOwn(options, 'sessionId') ? options.sessionId : 'session-1'
  const view = options.view ?? FIXTURE_VIEW
  const plugin = loadPlugin()
  const ctx = makeContext()
  plugin.apply(ctx)
  const component = ctx.__registrations[0].component
  const t = ctx.locale.bind('directive-ledger')
  return { tree: component({ useProjection: () => view, t, sessionId }), t }
}

test('each in-force row offers a removal control', () => {
  const { tree } = renderDock()
  const buttons = findAll(tree, (element) => element.props?.className === 'dld-remove')
  // Three in-force entries in the fixture; the replaced one is not removable.
  assert.equal(buttons.length, 3)
  for (const button of buttons) {
    assert.ok(button.props['aria-label'].startsWith('删除这条要求'), 'the control must name what it removes')
    assert.equal(button.props.disabled, false)
  }
})

test('clicking removal posts to the host route with the directive identity', async () => {
  const { tree } = renderDock()
  const button = findAll(tree, (element) => element.props?.className === 'dld-remove')[0]
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, removed: 'd3-0' }) }
  }
  try {
    button.props.onClick({ stopPropagation() {} })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/plugins/directive-ledger/drop')
  assert.equal(calls[0].init.method, 'POST')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.sessionId, 'session-1')
  assert.equal(body.directiveId, 'd3-0')
})

test('without a session identity the dock omits the removal control', () => {
  const { tree } = renderDock({ sessionId: undefined })
  assert.equal(findAll(tree, (element) => element.props?.className === 'dld-remove').length, 0)
})
