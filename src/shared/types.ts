/**
 * Shared vocabulary between the Host runtime half and the Web client half.
 *
 * Nothing in this file depends on a DSH package: the wire contract is plain
 * JSON so the Host half stays loadable in any profile that mounts
 * `@deepseek-ai/dsh-host-webserver` and the client half stays loadable in the
 * browser module table (React only).
 *
 * @module dsh-turbo/shared/types
 */

/** The two execution modes of one Session. */
export type TurboMode = 'default' | 'turbo'

/** The two Turbo policies exposed by the Web slider. */
export type TurboGear = 'fast' | 'max'

/**
 * The Host-authoritative record for one Session.
 *
 * `revision` is the ordered-update guard: a client submits the revision it
 * observed and the Host rejects a stale write, so rapid double clicks and
 * two tabs cannot interleave into a lost update.
 */
export interface TurboSessionState {
  readonly sessionId: string
  readonly mode: TurboMode
  /** Selected Turbo policy. Preserved while Turbo is OFF. */
  readonly gear: TurboGear
  /** Monotonic per Session; 0 means "never written". */
  readonly revision: number
  /** Epoch milliseconds of the last accepted write; 0 for the default record. */
  readonly updatedAt: number
}

/** One acceleration mechanism and whether it is actually in effect. */
export interface TurboCapability {
  /** Stable id used by tests and the details popover. */
  readonly id: string
  /** `applied` really happens, `off` is available but disabled, `unavailable` has no hook. */
  readonly state: 'applied' | 'off' | 'unavailable'
  /** Human-readable explanation; never claims more than the runtime does. */
  readonly detail: string
}

/** Turn-level measurement for one Session, derived from the Session log. */
export interface TurboSessionMetrics {
  /** Completed turns observed since the Host started. */
  readonly turns: number
  /** Mean wall-clock turn duration in milliseconds, or null without data. */
  readonly avgLatencyMs: number | null
  /** Wall-clock duration of the most recently completed turn. */
  readonly lastLatencyMs: number | null
  /** Model steps in the most recently completed turn. */
  readonly lastSteps: number | null
  /** Tool calls in the most recently completed turn. */
  readonly lastToolCalls: number | null
  /**
   * Whether the last turn ran a command that looks like a verification step
   * (test / build / lint). Observation only — Turbo never blocks one.
   */
  readonly lastVerification: boolean | null
  /** Mode under which the last turn ran. */
  readonly lastMode: TurboMode | null
}

/** Successful state read: everything one client render needs. */
export interface TurboStateResponse {
  readonly ok: true
  readonly state: TurboSessionState
  readonly capabilities: readonly TurboCapability[]
  readonly metrics: TurboSessionMetrics
  readonly live: boolean
  readonly plugin: { readonly name: string; readonly version: string }
}

/** Rejected state change. */
export interface TurboStateConflict {
  readonly ok: false
  readonly code: 'conflict' | 'invalid' | 'unsupported'
  readonly message: string
  /** Current authoritative state when the rejection was a revision conflict. */
  readonly state?: TurboSessionState
}

/** Wire type for both directions of `/api/dsh-turbo/state`. */
export type TurboStateReply = TurboStateResponse | TurboStateConflict

/** `GET /api/dsh-turbo/health` payload for troubleshooting. */
export interface TurboHealthReply {
  readonly ok: true
  readonly name: string
  readonly version: string
  readonly trackedSessions: number
  readonly capabilities: readonly TurboCapability[]
  /** Extra facts that make a "why is this not working" question answerable. */
  readonly diagnostics?: {
    /** Reachability of the optional `agents` service (`present:3`, `absent`). */
    readonly agentsService: string
    /** Live agents observed through `agent/created` since this row loaded. */
    readonly observedAgents: number
    /** Evidence log path, or `off` when disabled. */
    readonly evidence: string
  }
}

/** Plugin configuration keys, all optional in the bundle patch. */
export interface TurboConfig {
  /** Prompt section order. Default 700 (unowned gap in DSH SECTION_ORDERS). */
  readonly sectionOrder: number
  /** Request-level reasoning effort for the Fast gear. */
  readonly reasoningEffort: 'inherit' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max'
  /** Request-level reasoning effort for the Max gear. */
  readonly maxReasoningEffort: 'inherit' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max'
  /** Append applied-policy evidence lines to storageDir/evidence.jsonl. */
  readonly evidenceLog: boolean
  /** Subdirectory of $DSH_HOME/storages for state, metrics and evidence. */
  readonly storageDir: string
  /**
   * Mode a Session that was never toggled reads as. Default `default` (Turbo
   * OFF for new Sessions); `turbo` makes Turbo the deployment default.
   */
  readonly defaultMode: TurboMode
  /** Gear a never-toggled Turbo Session starts with. Default `fast`. */
  readonly defaultGear: TurboGear
}
