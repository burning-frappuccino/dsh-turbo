/**
 * A fake Cordis Host context, shaped exactly like the surface the plugin uses
 * (see src/host/cordis-surface.ts).
 *
 * Tests drive the *shipped* Host bundle (lib/index.js) through this context, so
 * a regression in wiring shows up here instead of only in a live profile.
 */

/** @returns {object} the fake context plus inspection handles */
export function createFakeHost({ systemPrompt = true, webServer = true, agents = undefined } = {}) {
  const routes = []
  const effects = []
  const listeners = new Map()
  const sections = []
  const logs = []

  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      debug: () => {},
    },
    effect(fn, label) {
      const cleanup = fn()
      const disposer = () => {
        if (typeof cleanup === 'function') cleanup()
      }
      effects.push({ label, disposer })
      return disposer
    },
    on(name, listener) {
      const entry = listeners.get(name) ?? []
      entry.push(listener)
      listeners.set(name, entry)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter((item) => item !== listener))
      }
    },
    inject(deps, callback) {
      if (deps.includes('systemPrompt') && !systemPrompt) return () => {}
      const cleanup = callback(ctx)
      const disposer = () => {
        if (typeof cleanup === 'function') cleanup()
      }
      effects.push({ label: `inject:${deps.join(',')}`, disposer })
      return disposer
    },
    get: (name) => ctx[name],
  }

  if (systemPrompt) {
    ctx.systemPrompt = {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      getSectionOrder: () => 700,
    }
  }

  if (webServer) {
    ctx.webServer = {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    }
  }

  if (agents !== undefined) {
    ctx.agents = {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    }
  }

  return {
    ctx,
    routes,
    effects,
    listeners,
    sections,
    logs,
    /** Invoke one waterfall listener chain in registration order. */
    async dispatchWaterfall(name, payload, terminal) {
      const chain = [...(listeners.get(name) ?? [])]
      const run = async (index, currentPayload) => {
        if (index >= chain.length) return terminal(currentPayload)
        return chain[index](currentPayload, () => run(index + 1, currentPayload))
      }
      return run(0, payload)
    },
    /** Emit a plain event to every listener. */
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    count(name) {
      return (listeners.get(name) ?? []).length
    },
    teardown() {
      for (const entry of effects.reverse()) {
        try {
          entry.disposer()
        } catch {
          /* best effort */
        }
      }
    },
  }
}

/** Minimal `req` object accepted by the plugin's handlers. */
export function fakeRequest({ method = 'GET', url = '/', headers = {}, body = undefined } = {}) {
  const handlers = new Map()
  return {
    method,
    url,
    headers,
    on(event, listener) {
      handlers.set(event, listener)
      if (event === 'data' && body !== undefined) {
        queueMicrotask(() => listener(Buffer.from(body)))
      }
      if (event === 'end') {
        queueMicrotask(() => listener())
      }
    },
    get handlerCount() {
      return handlers.size
    },
  }
}

/** Minimal `res` object that records what the handler wrote. */
export function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(body) {
      state.body = body ?? ''
    },
    json() {
      return state.body === '' ? undefined : JSON.parse(state.body)
    },
  }
}
