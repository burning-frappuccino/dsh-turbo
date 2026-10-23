/**
 * Session-scoped Turbo state with a Host-authoritative revision guard.
 *
 * The Session id is the only key. A Session that has never been written reads
 * as `mode: 'default', revision: 0` — so a new Session is OFF and re-opening a
 * Session restores the last accepted setting.
 *
 * Concurrency model: one in-memory `Map` is authoritative; every accepted
 * write bumps the revision. A client submits `expectedRevision` and a stale
 * submission is rejected with the current record instead of overwriting it,
 * which is what makes double clicks and two browser tabs converge on one value.
 *
 * @module dsh-turbo/host/session-store
 */

import type { TurboGear, TurboMode, TurboSessionState } from '../shared/types.js'
import { JsonFile } from './json-file.js'

/** Persisted document shape. `version` gates future migrations. */
interface StateDocumentV1 {
  version: 1
  sessions: Record<string, { mode: TurboMode; revision: number; updatedAt: number }>
}

interface StateDocumentV2 {
  version: 2
  sessions: Record<string, { mode: TurboMode; gear: TurboGear; revision: number; updatedAt: number }>
}

type StateDocument = StateDocumentV1 | StateDocumentV2

export interface SetOutcome {
  /** Whether the request changed anything. */
  readonly changed: boolean
  /** The authoritative record after the call. */
  readonly state: TurboSessionState
  /** Set when a supplied expectedRevision did not match. */
  readonly conflict?: boolean
}

export interface SessionStoreOptions {
  /** Absolute path of the JSON document, or undefined for memory-only. */
  readonly path?: string
  /** Mode a Session with no written record reads as. Default `default`. */
  readonly defaultMode?: TurboMode
  /** Gear a Session with no written record reads as. Default `fast`. */
  readonly defaultGear?: TurboGear
  /** Entries untouched for this long are dropped on prune. Default 30 days. */
  readonly ttlMs?: number
  /** Hard cap on retained Sessions. Default 2000. */
  readonly maxSessions?: number
  /** Clock injection for tests. */
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

const DEFAULT_RECORD = Object.freeze({ mode: 'default' as TurboMode, gear: 'fast' as TurboGear, revision: 0, updatedAt: 0 })

/** Validate a wire value before it can reach the store. */
export function parseMode(value: unknown): TurboMode | undefined {
  return value === 'turbo' || value === 'default' ? value : undefined
}

/** Validate a gear received from the browser or a persisted document. */
export function parseGear(value: unknown): TurboGear | undefined {
  return value === 'fast' || value === 'max' ? value : undefined
}

/** Session ids are harness-minted; reject anything that is not a plain token. */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,200}$/.test(value)
}

export class TurboSessionStore {
  readonly #entries = new Map<string, { mode: TurboMode; gear: TurboGear; revision: number; updatedAt: number }>()
  readonly #file: JsonFile<StateDocument> | undefined
  readonly #defaultMode: TurboMode
  readonly #defaultGear: TurboGear
  readonly #ttlMs: number
  readonly #maxSessions: number
  readonly #now: () => number
  readonly #listeners = new Set<(state: TurboSessionState, cause: string) => void>()

  constructor(options: SessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 30 * 24 * 60 * 60 * 1000
    this.#maxSessions = options.maxSessions ?? 2000
    this.#now = options.now ?? Date.now
    this.#defaultMode = options.defaultMode ?? DEFAULT_RECORD.mode
    this.#defaultGear = options.defaultGear ?? DEFAULT_RECORD.gear
    this.#file = options.path === undefined ? undefined : new JsonFile<StateDocument>(options.path, {
      onError: options.onError,
    })
    const loaded = this.#file?.load()
    if (loaded !== undefined && (loaded.version === 1 || loaded.version === 2) && typeof loaded.sessions === 'object' && loaded.sessions !== null) {
      for (const [sessionId, record] of Object.entries(loaded.sessions)) {
        if (!isSessionId(sessionId)) continue
        const mode = parseMode(record?.mode)
        if (mode === undefined) continue
        const gear = loaded.version === 2
          ? (parseGear((record as { gear?: unknown }).gear) ?? 'fast')
          : 'fast'
        const revision = Number.isInteger(record.revision) && record.revision > 0 ? record.revision : 0
        const updatedAt = Number.isFinite(record.updatedAt) && record.updatedAt > 0 ? record.updatedAt : 0
        this.#entries.set(sessionId, { mode, gear, revision, updatedAt })
      }
    }
  }

  /** Number of Sessions with an explicitly written record. */
  get size(): number {
    return this.#entries.size
  }

  /** Read one authoritative record; absent Sessions read as the configured default. */
  get(sessionId: string): TurboSessionState {
    const record = this.#entries.get(sessionId)
    if (record === undefined) {
      return {
        sessionId,
        mode: this.#defaultMode,
        gear: this.#defaultGear,
        revision: 0,
        updatedAt: 0,
      }
    }
    return {
      sessionId,
      mode: record.mode,
      gear: record.gear,
      revision: record.revision,
      updatedAt: record.updatedAt,
    }
  }

  /**
   * Apply a mode change.
   *
   * @param sessionId - validated Session id.
   * @param mode - requested mode.
   * @param expectedRevision - the revision the caller observed, or undefined
   *   for an unconditional write.
   */
  set(sessionId: string, mode: TurboMode, expectedRevision?: number, gear?: TurboGear): SetOutcome {
    const current = this.get(sessionId)
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      return { changed: false, state: current, conflict: true }
    }
    const nextGear = gear ?? current.gear
    if (current.mode === mode && current.gear === nextGear) {
      // Idempotent: keep the revision stable so a no-op click cannot invalidate
      // a concurrent tab's expected revision.
      return { changed: false, state: current }
    }
    const next = {
      mode,
      gear: nextGear,
      revision: current.revision + 1,
      updatedAt: this.#now(),
    }
    this.#entries.set(sessionId, next)
    this.#persist()
    const state: TurboSessionState = { sessionId, ...next }
    this.#emit(state, 'set')
    return { changed: true, state }
  }

  /** Subscribe to accepted writes; returns the unsubscribe function. */
  subscribe(listener: (state: TurboSessionState, cause: string) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Drop expired records; returns how many were removed. */
  prune(): number {
    const cutoff = this.#now() - this.#ttlMs
    let removed = 0
    for (const [sessionId, record] of this.#entries) {
      if (record.updatedAt < cutoff) {
        this.#entries.delete(sessionId)
        removed += 1
      }
    }
    if (this.#entries.size > this.#maxSessions) {
      const oldest = [...this.#entries.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      for (const [sessionId] of oldest.slice(0, this.#entries.size - this.#maxSessions)) {
        this.#entries.delete(sessionId)
        removed += 1
      }
    }
    if (removed > 0) this.#persist()
    return removed
  }

  /** Flush pending writes (teardown path). */
  flush(): void {
    this.#file?.flush()
  }

  #persist(): void {
    if (this.#file === undefined) return
    const sessions: StateDocumentV2['sessions'] = {}
    for (const [sessionId, record] of this.#entries) sessions[sessionId] = { ...record }
    this.#file.save({ version: 2, sessions })
  }

  #emit(state: TurboSessionState, cause: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(state, cause)
      } catch {
        /* a listener must not break a write */
      }
    }
  }
}
