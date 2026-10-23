/**
 * Append-only evidence log.
 *
 * Phase 2's acceptance test is "the same task behaves differently and a log
 * proves it" — reply text is not evidence. Every applied policy boundary
 * writes one JSON line here, so `evidence.jsonl` can be diffed between a
 * Turbo ON turn and a Turbo OFF turn.
 *
 * The file is capped: when it exceeds `maxBytes` it is rotated to `.1` (one
 * generation kept), so a long-lived profile cannot fill the disk.
 *
 * @module dsh-turbo/host/evidence
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface EvidenceRecord {
  /** Monotonic event name: `pre-step`, `mode-change`, `turn-end`, `unsupported`. */
  readonly event: string
  readonly session: string
  readonly [key: string]: unknown
}

export interface EvidenceOptions {
  /** Absolute path of the JSONL file, or undefined to disable logging. */
  readonly path?: string
  /** Rotation threshold. Default 1 MiB. */
  readonly maxBytes?: number
  /** Clock injection for tests. */
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

export class EvidenceLog {
  readonly #path: string | undefined
  readonly #maxBytes: number
  readonly #now: () => number
  readonly #onError: (error: unknown) => void
  #bytes = 0

  constructor(options: EvidenceOptions = {}) {
    this.#path = options.path
    this.#maxBytes = options.maxBytes ?? 1024 * 1024
    this.#now = options.now ?? Date.now
    this.#onError = options.onError ?? (() => {})
    if (this.#path !== undefined) {
      try {
        this.#bytes = statSync(this.#path).size
      } catch {
        this.#bytes = 0
      }
    }
  }

  get enabled(): boolean {
    return this.#path !== undefined
  }

  get path(): string | undefined {
    return this.#path
  }

  /** Append one record. Never throws into the caller's hook. */
  write(record: EvidenceRecord): void {
    if (this.#path === undefined) return
    const line = `${JSON.stringify({ ts: this.#now(), ...record })}\n`
    try {
      if (this.#bytes + line.length > this.#maxBytes) this.#rotate()
      mkdirSync(dirname(this.#path), { recursive: true })
      appendFileSync(this.#path, line, 'utf8')
      this.#bytes += Buffer.byteLength(line)
    } catch (error) {
      this.#onError(error)
    }
  }

  #rotate(): void {
    if (this.#path === undefined) return
    try {
      renameSync(this.#path, `${this.#path}.1`)
    } catch {
      /* the previous generation is replaced best-effort */
    }
    this.#bytes = 0
  }
}
