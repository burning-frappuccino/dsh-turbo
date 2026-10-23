/**
 * Client half: the shipped browser bundle must register itself with the DSH
 * module loader, claim the right slot, and keep the Host authoritative.
 *
 * The bundle is executed for real (via `vm`) with a fake module table, so this
 * test fails if the wrapper, the `id`, the required modules, or the export shape
 * drift.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')

/** Minimal React surface: the toggle is only looked at, never rendered here. */
const reactStub = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  Fragment: Symbol('Fragment'),
  memo: (component) => component,
  createContext: () => ({ Provider: () => null, Consumer: () => null }),
}
const jsxStub = { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }

/** Evaluate the bundle the way the browser kernel does. */
function loadBundle() {
  const loads = []
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (entry) => loads.push(entry) } }
  try {
    vm.runInThisContext(bundle, { filename: 'lib/client.js' })
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.equal(loads.length, 1, 'the bundle registers exactly one module')
  return loads[0]
}

function requireStub(name) {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return jsxStub
  if (name === 'react-dom') return {}
  if (name === 'react-dom/client') return {}
  throw new Error(`unexpected module request: ${name}`)
}

test('the bundle registers under the package name and exports a Cordis plugin', () => {
  const entry = loadBundle()
  assert.equal(entry.id, 'dsh-turbo')
  assert.equal(typeof entry.factory, 'function')

  const plugin = entry.factory(requireStub)
  assert.equal(typeof plugin.apply, 'function', 'client plugins export apply(ctx)')
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'])
})

test('apply claims conversation.input.right, not the single-occupant activity slot', () => {
  const entry = loadBundle()
  const plugin = entry.factory(requireStub)

  const registered = []
  const injectedInto = []
  const locales = []
  const ctx = {
    logger: { warn: () => {} },
    locale: {
      register: (ns, dictionaries) => locales.push([ns, dictionaries]),
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, factory) => {
        injectedInto.push(name)
        return factory()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect: (fn) => fn(),
  }

  plugin.apply(ctx)

  assert.deepEqual(injectedInto, ['conversation.input.right'])
  assert.equal(registered.length, 1)
  const { options, component } = registered[0]
  assert.equal(options.name, 'conversation.input.right')
  assert.equal(options.id, 'dsh-turbo', 'list slots require a stable id')
  assert.equal(options.locale, 'turbo')
  assert.equal(typeof component, 'function')

  const injected = options.inject('session-abc')
  assert.equal(injected.turboSessionId, 'session-abc', 'the component receives the session binding')

  assert.equal(locales.length, 1)
  const [ns, dictionaries] = locales[0]
  assert.equal(ns, 'turbo')
  assert.ok(dictionaries.zh && dictionaries.en)
  assert.deepEqual(
    Object.keys(dictionaries.zh).sort(),
    Object.keys(dictionaries.en).sort(),
    'every zh key has an en translation',
  )
  for (const key of ['label.on', 'label.off', 'label.switching', 'label.unavailable']) {
    assert.equal(typeof dictionaries.zh[key], 'string', `${key} is present`)
  }
  assert.equal(dictionaries.zh['details.flow.value'], '约 20%')
  assert.equal(dictionaries.zh['details.speed.value'], '约 1.5×')
  assert.match(dictionaries.zh['details.try'], /小测试/)
  assert.equal(dictionaries.zh['details.mode'], undefined, 'the public panel does not expose diagnostics')
})

test('apply degrades without a slot service instead of throwing', () => {
  const entry = loadBundle()
  const plugin = entry.factory(requireStub)
  const warnings = []
  plugin.apply({
    logger: { warn: (...args) => warnings.push(args) },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {},
    effect: (fn) => fn(),
  })
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /slot service is unavailable/)
})

// ── controller: the Host stays authoritative ─────────────────────────────────

const okBody = (overrides = {}) => ({
  ok: true,
  state: { sessionId: 'session-abc', mode: 'turbo', revision: 2, updatedAt: 10 },
  capabilities: [{ id: 'prompt-policy', state: 'applied', detail: 'x' }],
  metrics: {
    turns: 1,
    avgLatencyMs: 1200,
    lastLatencyMs: 1200,
    lastSteps: 3,
    lastToolCalls: 2,
    lastVerification: false,
    lastMode: 'turbo',
  },
  live: true,
  plugin: { name: 'dsh-turbo', version: '0.1.0' },
  ...overrides,
})

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
  }
}

test('a read returns the Host record and its capabilities', async () => {
  const { TurboController } = loadPluginExports()
  const calls = []
  const controller = new TurboController('session-abc', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(okBody())
    },
  })
  const result = await controller.read()
  assert.equal(result.kind, 'ok')
  assert.equal(result.view.state.mode, 'turbo')
  assert.equal(result.view.metrics.avgLatencyMs, 1200)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /^\/api\/dsh-turbo\/state\?sessionId=session-abc$/)
  assert.equal(calls[0].init.method, 'GET')
})

test('a write sends the observed revision and returns the confirmed state', async () => {
  const { TurboController } = loadPluginExports()
  const calls = []
  const controller = new TurboController('session-abc', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(okBody())
    },
  })
  const result = await controller.write('turbo', 1)
  assert.equal(result.kind, 'ok')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 'session-abc',
    mode: 'turbo',
    expectedRevision: 1,
  })
})

test('a 409 conflict is surfaced with the authoritative state, not retried', async () => {
  const { TurboController } = loadPluginExports()
  let count = 0
  const controller = new TurboController('session-abc', {
    fetchImpl: async () => {
      count += 1
      return jsonResponse({
        ok: false,
        code: 'conflict',
        message: 'changed elsewhere',
        state: { sessionId: 'session-abc', mode: 'default', revision: 7, updatedAt: 5 },
      }, 409)
    },
  })
  const result = await controller.write('turbo', 2)
  assert.equal(count, 1, 'a conflict is never retried automatically')
  assert.equal(result.kind, 'conflict')
  assert.equal(result.view.state.mode, 'default')
  assert.equal(result.view.state.revision, 7)
})

test('an unreachable Host is reported as offline, never as a mode', async () => {
  const { TurboController } = loadPluginExports()
  const controller = new TurboController('session-abc', {
    fetchImpl: async () => {
      throw new TypeError('fetch failed')
    },
  })
  const result = await controller.read()
  assert.equal(result.kind, 'offline')
})

test('a malformed payload is an error, not a silently accepted mode', async () => {
  const { TurboController } = loadPluginExports()
  const controller = new TurboController('session-abc', {
    fetchImpl: async () => jsonResponse({ ok: true, state: { mode: 'warp' } }),
  })
  const result = await controller.read()
  assert.equal(result.kind, 'error')
})

test('a 400 is reported as invalid so the UI can say the Host refused', async () => {
  const { TurboController } = loadPluginExports()
  const controller = new TurboController('session-abc', {
    fetchImpl: async () => jsonResponse({ ok: false, code: 'invalid', message: 'bad sessionId' }, 400),
  })
  const result = await controller.read()
  assert.equal(result.kind, 'invalid')
  assert.match(result.message, /bad sessionId/)
})

/** Load the client bundle and return its exported values. */
function loadPluginExports() {
  const entry = loadBundle()
  return entry.factory(requireStub)
}
