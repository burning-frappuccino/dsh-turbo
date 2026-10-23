/**
 * Host half of DSH Turbo.
 *
 * Responsibilities (per the project brief §3.2):
 * - own the per-Session execution mode, with the Host as the only authority;
 * - expose read/update over the profile's own HTTP bridge (`/api/...`);
 * - apply the policy at real lifecycle boundaries (see runtime-adapter.ts);
 * - record turn metrics and evidence;
 * - withdraw every registration when the bundle is unloaded.
 *
 * The plugin imports no DSH package: it is a plain Cordis functional plugin
 * (`inject` + `apply(ctx, config)`), so a patch release cannot break its module
 * identity. Services are reached through `ctx.inject()` and reported as
 * `unavailable` when absent instead of crashing the profile.
 *
 * @module dsh-turbo/host/plugin
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TurboConfig, TurboHealthReply, TurboStateReply } from '../shared/types.js'
import { isTurbo } from '../shared/policies.js'
import { PLUGIN_NAME, PLUGIN_VERSION } from '../version.js'
import { EvidenceLog } from './evidence.js'
import { TurboMetrics } from './metrics.js'
import { TurboSessionStore, isSessionId, parseMode } from './session-store.js'
import { RuntimeAdapter } from './runtime-adapter.js'
import type { Disposer, HttpRoute, TurboContext } from './cordis-surface.js'

/** The subset of `ctx.agents` this plugin reads (see the Host Service contract). */
interface AgentRegistryLike {
  get?: (id: string) => unknown
  list?: () => unknown[]
}

export const name = PLUGIN_NAME

/**
 * No hard service dependency.
 *
 * The execution policy belongs wherever agents run — the Web profile, the
 * headless one-shot runner, the SDK — so requiring `webServer` here would
 * silently disable Turbo outside a browser surface. The HTTP bridge instead
 * waits for `webServer` optionally and reports itself as `unavailable` when a
 * composition has none.
 */
export const inject: readonly string[] = []

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/api/dsh-turbo'

/** Request body cap; a state change is a few dozen bytes. */
const MAX_BODY_BYTES = 16 * 1024

const DEFAULTS: TurboConfig = {
  sectionOrder: 700,
  // Safe default. The lever is route-specific: the shipped DeepSeek Messages
  // adapter accepts only `off | low | high | max`, so defaulting to `minimal`
  // would fail every Turbo turn with UNSUPPORTED_REASONING_EFFORT.
  reasoningEffort: 'inherit',
  evidenceLog: true,
  storageDir: 'dsh-turbo',
  defaultMode: 'default',
}

/**
 * Accepted effort ids: the union the adapters in the wild understand
 * (`minimal`/`medium` exist for other routes). It is not a promise that one
 * route accepts all of them — the adapter validates per call, and the plugin
 * degrades (see the `agent/request-error` handler in runtime-adapter) instead
 * of failing the turn.
 */
const EFFORTS = new Set(['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'max'])
const MODES = new Set(['default', 'turbo'])

/** Validate the row's config; unknown keys are rejected so typos fail loudly. */
export function resolveConfig(raw: unknown): TurboConfig {
  if (raw === undefined || raw === null) return DEFAULTS
  if (typeof raw !== 'object') throw new Error('dsh-turbo: config must be an object')
  const input = raw as Record<string, unknown>
  const known = new Set(['sectionOrder', 'reasoningEffort', 'evidenceLog', 'storageDir', 'defaultMode'])
  const unknown = Object.keys(input).filter((key) => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(`dsh-turbo: unknown config key(s) ${unknown.join(', ')} — accepted keys are ${[...known].join(', ')}`)
  }
  const sectionOrder = input.sectionOrder ?? DEFAULTS.sectionOrder
  if (typeof sectionOrder !== 'number' || !Number.isFinite(sectionOrder)) {
    throw new Error('dsh-turbo: config sectionOrder must be a finite number')
  }
  const reasoningEffort = input.reasoningEffort ?? DEFAULTS.reasoningEffort
  if (typeof reasoningEffort !== 'string' || !EFFORTS.has(reasoningEffort)) {
    throw new Error(`dsh-turbo: config reasoningEffort must be one of ${[...EFFORTS].join(', ')}`)
  }
  const evidenceLog = input.evidenceLog ?? DEFAULTS.evidenceLog
  if (typeof evidenceLog !== 'boolean') throw new Error('dsh-turbo: config evidenceLog must be a boolean')
  const storageDir = input.storageDir ?? DEFAULTS.storageDir
  if (typeof storageDir !== 'string' || !/^[A-Za-z0-9._-]+$/.test(storageDir)) {
    throw new Error('dsh-turbo: config storageDir must be a simple directory name')
  }
  const defaultMode = input.defaultMode ?? DEFAULTS.defaultMode
  if (typeof defaultMode !== 'string' || !MODES.has(defaultMode)) {
    throw new Error('dsh-turbo: config defaultMode must be "default" or "turbo"')
  }
  return {
    sectionOrder,
    reasoningEffort: reasoningEffort as TurboConfig['reasoningEffort'],
    evidenceLog,
    storageDir,
    defaultMode: defaultMode as TurboConfig['defaultMode'],
  }
}

/** Resolve `$DSH_HOME` the way the harness does, with a portable fallback. */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** The Host half's Cordis entry point. */
export function apply(ctx: TurboContext, rawConfig?: unknown): void {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger
  const dir = join(dshHome(), 'storages', config.storageDir)

  // Flipped by the optional `webServer` registration below; read by the adapter
  // so the capability list reports the bridge truthfully.
  let httpBridge = false

  const store = new TurboSessionStore({
    path: join(dir, 'state.json'),
    defaultMode: config.defaultMode,
    onError: (error) => log?.warn('dsh-turbo: state write failed: %o', error),
  })
  const metrics = new TurboMetrics({
    path: join(dir, 'metrics.json'),
    onError: (error) => log?.warn('dsh-turbo: metrics write failed: %o', error),
  })
  const evidence = new EvidenceLog({
    path: config.evidenceLog ? join(dir, 'evidence.jsonl') : undefined,
    onError: (error) => log?.warn('dsh-turbo: evidence write failed: %o', error),
  })
  const adapter = new RuntimeAdapter({
    ctx,
    store,
    metrics,
    evidence,
    config,
    bridgeAvailable: () => httpBridge,
  })

  // Every registration below is owned by this plugin's Cordis fiber, so an
  // unload (bundle deselected, profile reload, `dsh` restart) withdraws the
  // routes, the prompt section, the hooks and the state subscription without a
  // manual undo path. Flushing the two documents is the only work left.
  const detachStore = store.subscribe((state) => {
    evidence.write({
      event: 'mode-change',
      session: state.sessionId,
      mode: state.mode,
      revision: state.revision,
      turbo: isTurbo(state.mode),
    })
  })
  const detachAdapter = adapter.attach()

  // Optional services are resolved through `ctx.inject`, which is the sanctioned
  // way to reach a service a plugin does not hard-depend on: an undeclared
  // property read on a Cordis fiber context yields `undefined` (the fiber is
  // only wired for names in `inject`). `agents` is cosmetic here — the bridge
  // still serves and stores state with no live agent — so it stays optional.
  const optional: { agents?: AgentRegistryLike } = {}
  ctx.inject?.(['agents'], (serviceCtx) => {
    const registry = (serviceCtx as Record<string, unknown>)['agents']
    if (registry !== undefined && registry !== null) {
      optional.agents = registry as AgentRegistryLike
    }
  })

  // Belt and braces for `live`: ids observed through the plain `agent/*` events
  // since this row loaded. The registry lookup covers agents that predate the
  // load (this very session, for instance); the event set covers the case where
  // the optional service is unreachable.
  const observedAgents = new Set<string>()
  ctx.effect(() => {
    const onCreated = ctx.on('agent/created', ((payload: { agent?: { id?: string } }) => {
      if (typeof payload?.agent?.id === 'string') observedAgents.add(payload.agent.id)
    }) as never)
    const onDisposed = ctx.on('agent/disposed', ((payload: { agent?: { id?: string } }) => {
      if (typeof payload?.agent?.id === 'string') observedAgents.delete(payload.agent.id)
    }) as never)
    return () => {
      onCreated()
      onDisposed()
    }
  }, 'dsh-turbo: live agent tracking')

  const live = (sessionId: string): boolean => {
    if (observedAgents.has(sessionId)) return true
    try {
      const lookup = optional.agents?.get
      return typeof lookup === 'function' && lookup.call(optional.agents, sessionId) !== undefined
    } catch {
      return false
    }
  }

  const stateRoute: HttpRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: async (req, res) => {
      const request = req as {
        method?: string
        url?: string
        headers?: Record<string, string | string[] | undefined>
        on: (event: string, listener: (...args: never[]) => void) => void
      }
      const response = res as {
        writeHead: (status: number, headers: Record<string, string>) => void
        end: (body?: string) => void
      }
      const method = (request.method ?? 'GET').toUpperCase()

      if (method === 'GET' || method === 'HEAD') {
        const url = safeUrl(request.url)
        const sessionId = url?.searchParams.get('sessionId') ?? undefined
        if (!isSessionId(sessionId)) {
          sendJson(response, 400, {
            ok: false,
            code: 'invalid',
            message: 'sessionId is required and must be a plain session token',
          } satisfies TurboStateReply)
          return
        }
        sendJson(response, 200, {
          ok: true,
          state: store.get(sessionId),
          capabilities: adapter.capabilities(),
          metrics: metrics.summary(sessionId),
          live: live(sessionId),
          plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
        } satisfies TurboStateReply)
        return
      }

      if (method !== 'POST') {
        sendJson(response, 405, {
          ok: false,
          code: 'unsupported',
          message: 'Turbo state accepts GET and POST',
        } satisfies TurboStateReply)
        return
      }

      const contentType = String(request.headers?.['content-type'] ?? '')
      if (!contentType.toLowerCase().includes('application/json')) {
        sendJson(response, 415, {
          ok: false,
          code: 'invalid',
          message: 'POST /api/dsh-turbo/state requires content-type: application/json',
        } satisfies TurboStateReply)
        return
      }

      let body: unknown
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          code: 'invalid',
          message: error instanceof Error ? error.message : 'unreadable body',
        } satisfies TurboStateReply)
        return
      }

      if (typeof body !== 'object' || body === null) {
        sendJson(response, 400, {
          ok: false,
          code: 'invalid',
          message: 'body must be a JSON object',
        } satisfies TurboStateReply)
        return
      }
      const input = body as Record<string, unknown>
      const sessionId = input.sessionId
      const mode = parseMode(input.mode)
      if (!isSessionId(sessionId)) {
        sendJson(response, 400, {
          ok: false,
          code: 'invalid',
          message: 'sessionId is required and must be a plain session token',
        } satisfies TurboStateReply)
        return
      }
      if (mode === undefined) {
        sendJson(response, 400, {
          ok: false,
          code: 'invalid',
          message: 'mode must be "default" or "turbo"',
        } satisfies TurboStateReply)
        return
      }
      const expectedRevision = input.expectedRevision
      if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
        sendJson(response, 400, {
          ok: false,
          code: 'invalid',
          message: 'expectedRevision must be a non-negative integer when present',
        } satisfies TurboStateReply)
        return
      }

      const outcome = store.set(sessionId, mode, expectedRevision)
      if (outcome.conflict === true) {
        sendJson(response, 409, {
          ok: false,
          code: 'conflict',
          message: 'the session mode changed elsewhere; re-read the authoritative state',
          state: outcome.state,
        } satisfies TurboStateReply)
        return
      }
      sendJson(response, 200, {
        ok: true,
        state: outcome.state,
        capabilities: adapter.capabilities(),
        metrics: metrics.summary(sessionId),
        live: live(sessionId),
        plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      } satisfies TurboStateReply)
      log?.info('dsh-turbo: session %s mode=%s revision=%d', sessionId, outcome.state.mode, outcome.state.revision)
    },
  }

  const healthRoute: HttpRoute = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/health`,
    handler: (_req, res) => {
      let agentService = 'absent'
      try {
        if (optional.agents !== undefined) {
          const list = optional.agents.list
          agentService = typeof list === 'function'
            ? `present:${String((list.call(optional.agents) as unknown[]).length)}`
            : 'present:no-list'
        }
      } catch {
        agentService = 'present:probe-failed'
      }
      sendJson(res as never, 200, {
        ok: true,
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        trackedSessions: store.size,
        capabilities: adapter.capabilities(),
        diagnostics: {
          agentsService: agentService,
          observedAgents: observedAgents.size,
          evidence: evidence.enabled ? (evidence.path ?? 'on') : 'off',
        },
      } satisfies TurboHealthReply)
    },
  }

  // The HTTP bridge is optional on purpose: headless / SDK / ACP profiles have
  // no webServer, and the execution policy must still work there. The bridge's
  // presence is reported as a capability instead of gating the whole plugin.
  ctx.inject?.(['webServer'], (serviceCtx) => {
    const webServer = (serviceCtx as Record<string, unknown>)['webServer'] as
      | { register(route: HttpRoute): Disposer }
      | undefined
    if (webServer === undefined) return
    serviceCtx.effect(() => {
      httpBridge = true
      const disposeState = webServer.register(stateRoute)
      const disposeHealth = webServer.register(healthRoute)
      return () => {
        httpBridge = false
        disposeHealth()
        disposeState()
      }
    }, 'dsh-turbo: http bridge')
  })

  ctx.effect(() => () => {
    // Fiber-owned registrations are withdrawn by Cordis; this only releases
    // the two manual subscriptions and persists whatever is still buffered.
    detachAdapter()
    detachStore()
    store.flush()
    metrics.flush()
    log?.info('dsh-turbo: unloaded (routes, prompt section, hooks and state withdrawn)')
  }, 'dsh-turbo: lifetime')

  log?.info(
    'dsh-turbo %s: loaded (sectionOrder=%d, reasoningEffort=%s, evidence=%s)',
    PLUGIN_VERSION,
    config.sectionOrder,
    config.reasoningEffort,
    evidence.enabled ? (evidence.path ?? '') : 'off',
  )
}

function safeUrl(raw: string | undefined): URL | undefined {
  try {
    return new URL(raw ?? '/', 'http://dsh.local')
  } catch {
    return undefined
  }
}

function sendJson(
  response: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body?: string) => void },
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function readJsonBody(request: {
  on: (event: string, listener: (...args: never[]) => void) => void
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', ((chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    }) as never)
    request.on('end', (() => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(new Error(`malformed JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    }) as never)
    request.on('error', ((error: Error) => reject(error)) as never)
  })
}
