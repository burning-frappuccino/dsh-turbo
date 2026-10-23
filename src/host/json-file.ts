/**
 * A tiny JSON document with debounced atomic writes.
 *
 * Why not `ctx.storage`: the storage hub's domain service is a Host-internal
 * API whose shape is version-coupled (see compatibility-report.md §4). This
 * plugin owns exactly two small documents, so a 60-line file store keeps the
 * plugin installable across DSH patch releases without touching internals.
 *
 * Guarantees: `load()` never throws (a corrupt document is renamed aside and
 * starts empty); `save()` coalesces bursts into one write; `flush()` is the
 * synchronous-on-demand path used by teardown.
 *
 * @module dsh-turbo/host/json-file
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface JsonFileOptions {
  /** Debounce window for `save()`. */
  readonly debounceMs?: number
  /** Called when a write fails; the store keeps serving in-memory state. */
  readonly onError?: (error: unknown) => void
}

export class JsonFile<T> {
  readonly #path: string
  readonly #debounceMs: number
  readonly #onError: (error: unknown) => void
  #timer: NodeJS.Timeout | undefined
  #pending: T | undefined

  constructor(path: string, options: JsonFileOptions = {}) {
    this.#path = path
    this.#debounceMs = options.debounceMs ?? 250
    this.#onError = options.onError ?? (() => {})
  }

  get path(): string {
    return this.#path
  }

  /** Read the document, or `undefined` when it is absent or unreadable. */
  load(): T | undefined {
    try {
      if (!existsSync(this.#path)) return undefined
      const raw = readFileSync(this.#path, 'utf8')
      if (raw.trim() === '') return undefined
      return JSON.parse(raw) as T
    } catch (error) {
      // Keep the unreadable document for postmortem inspection instead of
      // silently destroying a user's settings.
      try {
        renameSync(this.#path, `${this.#path}.corrupt-${Date.now()}`)
      } catch {
        /* best effort */
      }
      this.#onError(error)
      return undefined
    }
  }

  /** Queue a write; the newest value wins. */
  save(value: T): void {
    this.#pending = value
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      const next = this.#pending
      this.#pending = undefined
      if (next !== undefined) this.#write(next)
    }, this.#debounceMs)
    // A profile that never unmounts should not be held open by this timer.
    this.#timer.unref?.()
  }

  /** Write the pending value immediately. */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    const next = this.#pending
    this.#pending = undefined
    if (next !== undefined) this.#write(next)
  }

  #write(value: T): void {
    const tmp = join(dirname(this.#path), `.${process.pid}-${Date.now()}.tmp`)
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, this.#path)
    } catch (error) {
      this.#onError(error)
    }
  }
}
