/**
 * Browser-side transport for the Turbo bridge.
 *
 * Kept free of React so `tests/toggle.test.mjs` can drive it with an injected
 * `fetch`. The contract it enforces is the one the brief asks for:
 * - the Host is the authority: a write returns the Host's record, never local
 *   optimism;
 * - a revision conflict is a first-class result the UI must show, not a retry
 *   loop that could ping-pong between two tabs;
 * - every failure mode (offline, HTTP error, malformed payload) has its own
 *   branch so the toggle can revert and say what happened.
 *
 * @module dsh-turbo/client/turbo-controller
 */

import type {
  TurboMode,
  TurboSessionState,
  TurboSessionMetrics,
  TurboCapability,
  TurboStateReply,
} from '../shared/types.js'

/** Default bridge prefix registered by the Host half. */
export const DEFAULT_BASE_PATH = '/api/dsh-turbo'

/** Everything one successful read returns. */
export interface TurboView {
  readonly state: TurboSessionState
  readonly capabilities: readonly TurboCapability[]
  readonly metrics: TurboSessionMetrics
  readonly live: boolean
}

/** Read/write outcome union. */
export type TurboResult =
  | { readonly kind: 'ok'; readonly view: TurboView }
  | { readonly kind: 'conflict'; readonly view: TurboView }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'offline'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }

export interface TurboControllerOptions {
  /** Bridge prefix. Default `/api/dsh-turbo`. */
  readonly basePath?: string
  /** Injected for tests; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Per-request timeout. Default 4000 ms. */
  readonly timeoutMs?: number
  /** AbortSignal source for tests. */
  readonly signal?: AbortSignal
}

export class TurboController {
  readonly #sessionId: string
  readonly #basePath: string
  readonly #fetch: typeof fetch | undefined
  readonly #timeoutMs: number
  readonly #signal: AbortSignal | undefined

  constructor(sessionId: string, options: TurboControllerOptions = {}) {
    this.#sessionId = sessionId
    this.#basePath = (options.basePath ?? DEFAULT_BASE_PATH).replace(/\/+$/, '')
    this.#fetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined)
    this.#timeoutMs = options.timeoutMs ?? 4000
    this.#signal = options.signal
  }

  get sessionId(): string {
    return this.#sessionId
  }

  /** `GET /state` — read the authoritative record for this Session. */
  async read(): Promise<TurboResult> {
    return this.#request('GET', `/state?sessionId=${encodeURIComponent(this.#sessionId)}`)
  }

  /**
   * `POST /state` — ask the Host to move this Session to `mode`.
   *
   * @param mode - target mode.
   * @param expectedRevision - the revision currently on screen; the Host
   *   rejects the write when another tab has moved past it.
   */
  async write(mode: TurboMode, expectedRevision: number | undefined): Promise<TurboResult> {
    const body: Record<string, unknown> = { sessionId: this.#sessionId, mode }
    if (expectedRevision !== undefined) body['expectedRevision'] = expectedRevision
    return this.#request('POST', '/state', body)
  }

  async #request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<TurboResult> {
    const fetchImpl = this.#fetch
    if (fetchImpl === undefined) return { kind: 'offline', message: 'this browser has no fetch implementation' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    const relay = () => controller.abort()
    this.#signal?.addEventListener('abort', relay, { once: true })

    try {
      const response = await fetchImpl(`${this.#basePath}${path}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const payload = await readJson(response)
      if (payload === undefined) {
        return { kind: 'error', message: `bridge returned ${response.status} with no JSON body` }
      }
      if (response.status === 409 && isConflict(payload)) {
        return {
          kind: 'conflict',
          view: {
            state: payload.state,
            capabilities: [],
            metrics: emptyMetrics(),
            live: false,
          },
        }
      }
      if (!response.ok || !isReply(payload)) {
        const message = typeof (payload as { message?: unknown }).message === 'string'
          ? String((payload as { message?: unknown }).message)
          : `bridge returned ${response.status}`
        return response.status === 400 ? { kind: 'invalid', message } : { kind: 'error', message }
      }
      return {
        kind: 'ok',
        view: {
          state: payload.state,
          capabilities: payload.capabilities,
          metrics: payload.metrics,
          live: payload.live,
        },
      }
    } catch (error) {
      if (isAbort(error)) return { kind: 'offline', message: 'the Host answered too slowly; Turbo state unknown' }
      return { kind: 'offline', message: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
      this.#signal?.removeEventListener('abort', relay)
    }
  }
}

/** Empty metrics value used by a conflict reply (it carries state only). */
export function emptyMetrics(): TurboSessionMetrics {
  return {
    turns: 0,
    avgLatencyMs: null,
    lastLatencyMs: null,
    lastSteps: null,
    lastToolCalls: null,
    lastVerification: null,
    lastMode: null,
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

function isReply(value: unknown): value is Extract<TurboStateReply, { ok: true }> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record['ok'] !== true) return false
  const state = record['state']
  if (typeof state !== 'object' || state === null) return false
  const stateRecord = state as Record<string, unknown>
  return typeof stateRecord['sessionId'] === 'string'
    && (stateRecord['mode'] === 'turbo' || stateRecord['mode'] === 'default')
    && typeof stateRecord['revision'] === 'number'
    && Array.isArray(record['capabilities'])
    && typeof record['metrics'] === 'object'
}

function isConflict(value: unknown): value is { ok: false; state: TurboSessionState } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record['ok'] !== false || record['code'] !== 'conflict') return false
  const state = record['state']
  if (typeof state !== 'object' || state === null) return false
  const stateRecord = state as Record<string, unknown>
  return typeof stateRecord['sessionId'] === 'string'
    && (stateRecord['mode'] === 'turbo' || stateRecord['mode'] === 'default')
    && typeof stateRecord['revision'] === 'number'
}
