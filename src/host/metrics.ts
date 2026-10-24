/**
 * Turn metrics derived from the Session log, never from the model's prose.
 *
 * Sources (all official Cordis events):
 * - `session/event` `turn/start` / `turn/end` → wall-clock turn duration.
 * - `session/event` `tool/call` → tool-call count and verification observation.
 * - `agent/pre-step` → model steps per turn and the mode the step ran under.
 *
 * Everything here is observation. Measuring a turn never changes what the
 * agent does, which keeps the Turbo ON/OFF comparison honest.
 *
 * @module dsh-turbo/host/metrics
 */

import type { TurboMode, TurboSessionMetrics } from '../shared/types.js'
import { JsonFile } from './json-file.js'

/** One completed turn. */
export interface TurnRecord {
  readonly turn: number
  readonly mode: TurboMode
  readonly startedAt: number
  readonly endedAt: number
  readonly steps: number
  readonly toolCalls: number
  readonly verification: boolean
}

interface MetricsDocument {
  version: 1
  sessions: Record<string, TurnRecord[]>
}

export interface MetricsOptions {
  /** Absolute path of the metrics document, or undefined for memory-only. */
  readonly path?: string
  /** Turns retained per Session. Default 40. */
  readonly turnsPerSession?: number
  /** Sessions retained. Default 500. */
  readonly maxSessions?: number
  /** Clock injection for tests. */
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
}

/** Tools whose arguments can carry a shell command. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'ops_bash', 'shell', 'job_start', 'terminal'])

/** Commands that count as a real verification step. */
const VERIFICATION_COMMAND = /(?:^|[\s;&|])(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?(?:test|tests|lint|typecheck|build)\b|\b(?:python(?:3(?:\.\d+)?)?|py(?:\s+-\d+(?:\.\d+)?)?)\s+-m\s+unittest\b|\b(?:vitest|jest|pytest|mocha|ava|ctest|cargo\s+test|go\s+test|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|gradle\w*\s+(?:test|check|build)|tsc\b|node\s+--test)/i

/** Per-Session live bookkeeping that is not part of the durable record. */
interface LiveTurn {
  readonly turn: number
  readonly mode: TurboMode
  readonly startedAt: number
  steps: number
  toolCalls: number
  verification: boolean
}

export class TurboMetrics {
  readonly #turns = new Map<string, TurnRecord[]>()
  readonly #live = new Map<string, LiveTurn>()
  readonly #file: JsonFile<MetricsDocument> | undefined
  readonly #turnsPerSession: number
  readonly #maxSessions: number
  readonly #now: () => number

  constructor(options: MetricsOptions = {}) {
    this.#turnsPerSession = options.turnsPerSession ?? 40
    this.#maxSessions = options.maxSessions ?? 500
    this.#now = options.now ?? Date.now
    this.#file = options.path === undefined ? undefined : new JsonFile<MetricsDocument>(options.path, {
      onError: options.onError,
    })
    const loaded = this.#file?.load()
    if (loaded !== undefined && loaded.version === 1 && typeof loaded.sessions === 'object' && loaded.sessions !== null) {
      for (const [sessionId, records] of Object.entries(loaded.sessions)) {
        if (!Array.isArray(records)) continue
        const clean = records.filter(isTurnRecord).slice(-this.#turnsPerSession)
        if (clean.length > 0) this.#turns.set(sessionId, clean)
      }
    }
  }

  /** Open a turn; ignores repeats for a turn already in flight. */
  beginTurn(sessionId: string, turn: number, mode: TurboMode): void {
    const existing = this.#live.get(sessionId)
    if (existing !== undefined && existing.turn === turn) return
    this.#live.set(sessionId, { turn, mode, startedAt: this.#now(), steps: 0, toolCalls: 0, verification: false })
  }

  /** Count one model step for the live turn. */
  countStep(sessionId: string, turn: number): void {
    const live = this.#live.get(sessionId)
    if (live === undefined || live.turn !== turn) return
    live.steps += 1
  }

  /** Count one tool call and note whether it looks like verification. */
  countToolCall(sessionId: string, turn: number, toolName: string, rawArguments: unknown): void {
    const live = this.#live.get(sessionId)
    if (live === undefined || live.turn !== turn) return
    live.toolCalls += 1
    if (!live.verification && SHELL_TOOLS.has(toolName)) {
      live.verification = looksLikeVerification(rawArguments)
    }
  }

  /** Close the live turn and retain its record. */
  endTurn(sessionId: string, turn: number): TurnRecord | undefined {
    const live = this.#live.get(sessionId)
    if (live === undefined || live.turn !== turn) return undefined
    this.#live.delete(sessionId)
    const record: TurnRecord = {
      turn,
      mode: live.mode,
      startedAt: live.startedAt,
      endedAt: this.#now(),
      steps: live.steps,
      toolCalls: live.toolCalls,
      verification: live.verification,
    }
    const records = [...(this.#turns.get(sessionId) ?? []), record].slice(-this.#turnsPerSession)
    this.#turns.set(sessionId, records)
    if (this.#turns.size > this.#maxSessions) {
      const oldest = [...this.#turns.entries()].sort((a, b) => lastEnd(a[1]) - lastEnd(b[1]))
      for (const [id] of oldest.slice(0, this.#turns.size - this.#maxSessions)) this.#turns.delete(id)
    }
    this.#persist()
    return record
  }

  /** Read the client-facing summary for one Session. */
  summary(sessionId: string): TurboSessionMetrics {
    const records = this.#turns.get(sessionId) ?? []
    if (records.length === 0) {
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
    const last = records[records.length - 1]!
    const durations = records.map((record) => record.endedAt - record.startedAt)
    const total = durations.reduce((sum, value) => sum + value, 0)
    return {
      turns: records.length,
      avgLatencyMs: Math.round(total / durations.length),
      lastLatencyMs: durations[durations.length - 1]!,
      lastSteps: last.steps,
      lastToolCalls: last.toolCalls,
      lastVerification: last.verification,
      lastMode: last.mode,
    }
  }

  /** All retained records for one Session (benchmark + diagnostics). */
  records(sessionId: string): readonly TurnRecord[] {
    return this.#turns.get(sessionId) ?? []
  }

  /** Flush pending writes (teardown path). */
  flush(): void {
    this.#file?.flush()
  }

  #persist(): void {
    if (this.#file === undefined) return
    const sessions: MetricsDocument['sessions'] = {}
    for (const [sessionId, records] of this.#turns) sessions[sessionId] = records.map((record) => ({ ...record }))
    this.#file.save({ version: 1, sessions })
  }
}

/** Whether a shell tool call's arguments contain a verification command. */
export function looksLikeVerification(rawArguments: unknown): boolean {
  const command = commandOf(rawArguments)
  if (command === undefined) return false
  return VERIFICATION_COMMAND.test(command)
}

/** Extract a command string from the common shell-tool argument shapes. */
export function commandOf(rawArguments: unknown): string | undefined {
  let value = rawArguments
  if (typeof value === 'string') {
    const text = value
    try {
      value = JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script', 'line'] as const) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate !== '') return candidate
    if (Array.isArray(candidate)) {
      const joined = candidate.filter((part): part is string => typeof part === 'string').join(' ')
      if (joined !== '') return joined
    }
  }
  return undefined
}

function isTurnRecord(value: unknown): value is TurnRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.turn === 'number'
    && (record.mode === 'turbo' || record.mode === 'default')
    && typeof record.startedAt === 'number'
    && typeof record.endedAt === 'number'
    && typeof record.steps === 'number'
    && typeof record.toolCalls === 'number'
    && typeof record.verification === 'boolean'
}

function lastEnd(records: readonly TurnRecord[]): number {
  return records.length === 0 ? 0 : records[records.length - 1]!.endedAt
}
