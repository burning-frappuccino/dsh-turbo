/**
 * Harness adapter: maps the internal ExecutionPolicy onto the DSH hooks that
 * actually exist in the running Host, and reports honestly what it could not
 * control.
 *
 * Verified extension points (DSH 0.2.0-rc.2):
 *
 * | Mechanism              | Real hook                                                     |
 * |------------------------|---------------------------------------------------------------|
 * | Prompt policy          | `ctx.systemPrompt.section({ name, order, text })` — text may be  |
 * |                        | a per-assembly resolver receiving `{ agent }`, so one global    |
 * |                        | section renders only for Turbo Sessions.                       |
 * | Per-step policy stamp  | `agent/pre-step` waterfall `{ agent, turn, step, messages,     |
 * |                        | signal }` → decision `{ kind: 'enter' | 'reject', messages }`. |
 * | Turn/tool measurement  | `session/event` (`turn/start`, `turn/end`, `tool/call`).        |
 * | Reasoning effort       | Agent-scoped `agent/request` waterfall (opt-in).               |
 *
 * Deliberately NOT used:
 * - string filtering of shell commands (`test`, `build`) — it breaks real work;
 * - blocking tool registrations — same reason;
 * - a replacement agent loop — the shipped loop already has no optional
 *   review/test stage, so there is nothing to replace.
 *
 * @module dsh-turbo/host/runtime-adapter
 */

import type { TurboCapability, TurboConfig, TurboMode } from '../shared/types.js'
import { policyFor } from '../shared/policies.js'
import { renderTurboPolicy, TURBO_SECTION_NAME } from '../prompts/turbo-policy.js'
import { isSessionId } from './session-store.js'
import type { TurboSessionStore } from './session-store.js'
import type { TurboMetrics } from './metrics.js'
import type { EvidenceLog } from './evidence.js'
import type { AgentLike, Disposer, PromptSection, TurboContext } from './cordis-surface.js'

export interface AdapterOptions {
  readonly ctx: TurboContext
  readonly store: TurboSessionStore
  readonly metrics: TurboMetrics
  readonly evidence: EvidenceLog
  readonly config: TurboConfig
  /** Whether the HTTP bridge registered (set by the plugin row). */
  readonly bridgeAvailable?: () => boolean
}

/** Mutable mirror of what is really registered, served to the client verbatim. */
interface CapabilityState {
  promptSection: boolean
  preStepHook: boolean
  sessionMetrics: boolean
  /**
   * Ground truth for the reasoning-effort lever: set only after a real
   * `request/header` for a Turbo Session carried the configured value. An
   * installed hook is not evidence that a request used it — the model-selection
   * listener upstream of every plugin re-applies its own effort and would
   * otherwise let the UI claim a setting that never reached the wire.
   */
  reasoningEffort: boolean
  effortUnavailable: boolean
  /** Last `request/header` effort observed for a Turbo Session. */
  observedEffort?: string | undefined
  /** Why the route refused the configured effort, when it did. */
  effortError?: string | undefined
}

export class RuntimeAdapter {
  readonly #ctx: TurboContext
  readonly #store: TurboSessionStore
  readonly #metrics: TurboMetrics
  readonly #evidence: EvidenceLog
  readonly #config: TurboConfig
  readonly #bridgeAvailable: () => boolean
  readonly #caps: CapabilityState = {
    promptSection: false,
    preStepHook: false,
    sessionMetrics: false,
    reasoningEffort: false,
    effortUnavailable: false,
    observedEffort: undefined,
  }
  /** Agent-scoped request hooks owned by this adapter, keyed for de-duplication. */
  readonly #effortHooks = new Map<string, Disposer>()
  /** One warning per process when another listener wins the effort field. */
  #effortMismatchReported = false

  constructor(options: AdapterOptions) {
    this.#ctx = options.ctx
    this.#store = options.store
    this.#metrics = options.metrics
    this.#evidence = options.evidence
    this.#config = options.config
    this.#bridgeAvailable = options.bridgeAvailable ?? (() => false)
  }

  /** Register every hook; returns one disposer that withdraws all of them. */
  attach(): Disposer {
    const disposers: Disposer[] = []

    // ── 1. Prompt policy (requires the system-prompt service) ────────────────
    // `ctx.inject` defers until the service exists, so a profile without
    // system-prompt simply reports `unavailable` instead of failing to load.
    if (typeof this.#ctx.inject === 'function') {
      disposers.push(this.#ctx.inject(['systemPrompt'], (sctx) => {
        const systemPrompt = sctx.systemPrompt
        if (systemPrompt === undefined) return
        const section: PromptSection = {
          name: TURBO_SECTION_NAME,
          order: this.#config.sectionOrder,
          text: (context) => this.#promptFor(context?.agent),
        }
        const dispose = systemPrompt.section(section)
        this.#caps.promptSection = true
        return () => {
          this.#caps.promptSection = false
          dispose()
        }
      }))
    }

    // ── 2. Per-step policy stamp + step counting ─────────────────────────────
    disposers.push(this.#ctx.on('agent/pre-step', (async (
      payload: { agent?: AgentLike; turn?: number; step?: number; messages?: unknown[]; signal?: AbortSignal },
      next: () => Promise<{ kind: string; messages?: unknown[] }>,
    ) => {
      const decision = await next()
      try {
        this.#onPreStep(payload, decision)
      } catch (error) {
        this.#ctx.logger?.warn('dsh-turbo: pre-step bookkeeping failed: %o', error)
      }
      return decision
    }) as never))

    // ── 3. Turn/tool measurement from the Session log ────────────────────────
    disposers.push(this.#ctx.on('session/event', ((session: { id?: string } | undefined, event: {
      type?: string
      data?: Record<string, unknown>
    }) => {
      try {
        this.#onSessionEvent(session, event)
      } catch (error) {
        this.#ctx.logger?.warn('dsh-turbo: session metrics bookkeeping failed: %o', error)
      }
    }) as never))
    this.#caps.sessionMetrics = true

    // ── 4. Optional request-level reasoning effort ───────────────────────────
    if (this.#config.reasoningEffort !== 'inherit' || this.#config.maxReasoningEffort !== 'inherit') {
      const attach = (agent: AgentLike | undefined): void => {
        try {
          this.#attachEffort(agent)
        } catch (error) {
          this.#ctx.logger?.warn('dsh-turbo: reasoning-effort hook failed: %o', error)
        }
      }
      disposers.push(this.#ctx.on('agent/created', ((payload: { agent?: AgentLike }) => {
        attach(payload?.agent)
      }) as never))

      // A bundle can be enabled while a conversation is already open. The
      // registry is the supported way to recover those pre-existing Agents;
      // the id-keyed map keeps a later agent/created event idempotent.
      if (typeof this.#ctx.inject === 'function') {
        disposers.push(this.#ctx.inject(['agents'], (serviceCtx) => {
          const list = serviceCtx.agents?.list
          if (typeof list !== 'function') return
          try {
            for (const agent of list.call(serviceCtx.agents)) attach(agent)
          } catch (error) {
            this.#ctx.logger?.warn('dsh-turbo: existing-agent scan failed: %o', error)
          }
        }))
      }
    }

    // ── 5. Housekeeping: prune expired Session state ─────────────────────────
    disposers.push(this.#ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          this.#store.prune()
        } catch {
          /* prune is best-effort */
        }
      }, 10 * 60 * 1000)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'dsh-turbo: state pruning'))

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* one failing disposer must not strand the rest */
        }
      }
      for (const dispose of [...this.#effortHooks.values()]) {
        try {
          dispose()
        } catch {
          /* one failing Agent hook must not strand the rest */
        }
      }
      this.#effortHooks.clear()
      this.#caps.reasoningEffort = false
      this.#caps.observedEffort = undefined
    }
  }

  /** What is really in effect, in the exact words the client shows. */
  capabilities(): readonly TurboCapability[] {
    const fastEffort = this.#config.reasoningEffort
    const maxEffort = this.#config.maxReasoningEffort
    const effortEnabled = fastEffort !== 'inherit' || maxEffort !== 'inherit'
    return [
      {
        id: 'prompt-policy',
        state: this.#caps.promptSection ? 'applied' : 'unavailable',
        detail: this.#caps.promptSection
          ? `Ordered prompt section "${TURBO_SECTION_NAME}" renders only for Turbo Sessions.`
          : 'The host has no systemPrompt service, so no prompt policy can be added.',
      },
      {
        id: 'pre-step-policy',
        state: this.#caps.preStepHook ? 'applied' : 'unavailable',
        detail: this.#caps.preStepHook
          ? 'agent/pre-step stamps every step with the effective mode and records evidence.'
          : 'agent/pre-step is unavailable in this composition; nothing is enforced per step.',
      },
      {
        id: 'turn-metrics',
        state: this.#caps.sessionMetrics ? 'applied' : 'unavailable',
        detail: 'Turn latency, step count and tool calls are read from session events.',
      },
      {
        id: 'http-bridge',
        state: this.#bridgeAvailable() ? 'applied' : 'unavailable',
        detail: this.#bridgeAvailable()
          ? 'GET/POST /api/dsh-turbo/state serves the authoritative session mode.'
          : 'This profile has no webServer, so only the execution policy applies (headless/SDK surfaces).',
      },
      {
        id: 'reasoning-effort',
        state: !effortEnabled ? 'off' : this.#caps.reasoningEffort ? 'applied' : 'off',
        detail: !effortEnabled
          ? 'Model route untouched (both gear efforts inherit the selected route).'
          : this.#caps.reasoningEffort
            ? `Turbo requests carried the selected gear effort (Fast: "${fastEffort}", Max: "${maxEffort}") in request/header.`
            : this.#caps.effortError !== undefined
              ? `The route refused a selected gear effort (${this.#caps.effortError}); Turbo kept the turn alive and left the route untouched.`
              : this.#caps.effortUnavailable
                ? `Configured for Fast "${fastEffort}" / Max "${maxEffort}", but no Agent context was reachable.`
                : this.#caps.observedEffort !== undefined
                  ? `The selected gear effort did not reach the route; it resolved "${this.#caps.observedEffort}" instead.`
                  : `Configured for Fast "${fastEffort}" / Max "${maxEffort}"; no Turbo request has been observed yet.`,
      },
      {
        id: 'optional-stages',
        state: 'unavailable',
        detail: 'This composition mounts no automatic review/test stage, so Turbo cannot skip one — the model owns that choice, which is why the prompt policy states it.',
      },
      {
        id: 'tool-filtering',
        state: 'off',
        detail: 'No tool is blocked by name or argument: killing commands that mention test/build breaks real tasks.',
      },
      {
        id: 'mandatory-checks',
        state: 'applied',
        detail: 'Permissions, approvals, sandbox limits and required checks are never modified.',
      },
    ]
  }

  /** Effective mode for one Session (single source of truth). */
  modeOf(sessionId: string | undefined): TurboMode {
    return sessionId === undefined ? 'default' : this.#store.get(sessionId).mode
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Render the section text for one agent (empty string = contribute nothing). */
  #promptFor(agent: AgentLike | undefined): string {
    const sessionId = agent?.session?.id ?? agent?.id
    if (sessionId === undefined) return ''
    const state = this.#store.get(sessionId)
    if (state.mode !== 'turbo') return ''
    return renderTurboPolicy(state.gear)
  }

  #onPreStep(
    payload: { agent?: AgentLike; turn?: number; step?: number },
    decision: { kind: string },
  ): void {
    const agent = payload.agent
    const sessionId = agent?.session?.id ?? agent?.id
    const turn = typeof payload.turn === 'number' ? payload.turn : undefined
    if (sessionId === undefined || !isSessionId(sessionId) || turn === undefined) return
    if (decision.kind === 'reject') return

    const state = this.#store.get(sessionId)
    this.#caps.preStepHook = true
    this.#metrics.countStep(sessionId, turn)

    const policy = policyFor(state.mode, state.gear)
    this.#evidence.write({
      event: 'pre-step',
      session: sessionId,
      turn,
      step: typeof payload.step === 'number' ? payload.step : null,
      mode: state.mode,
      gear: state.gear,
      revision: state.revision,
      policy,
      promptSection: this.#caps.promptSection ? 'applied' : 'unavailable',
      // What the last request actually carried, not what this plugin asked for.
      reasoningEffort: this.#caps.observedEffort ?? null,
      reasoningEffortConfigured: this.#effortFor(state.gear),
    })
  }

  #onSessionEvent(
    session: { id?: string } | undefined,
    event: { type?: string; data?: Record<string, unknown> },
  ): void {
    const sessionId = session?.id
    if (sessionId === undefined || !isSessionId(sessionId)) return
    const type = event.type
    const data = event.data ?? {}
    if (type === 'turn/start') {
      const turn = turnOf(data)
      if (turn === undefined) return
      this.#metrics.beginTurn(sessionId, turn, this.#store.get(sessionId).mode)
      return
    }
    if (type === 'tool/call') {
      const turn = turnOf(data)
      if (turn === undefined) return
      const name = typeof data.name === 'string' ? data.name : ''
      this.#metrics.countToolCall(sessionId, turn, name, data.arguments)
      return
    }
    if (type === 'request/header') {
      // Ground truth for the effort lever: what the request actually carried,
      // not what this plugin asked for.
      const header = data['header'] as { config?: { reasoningEffort?: unknown } } | undefined
      const observed = header?.config?.reasoningEffort
      const state = this.#store.get(sessionId)
      if (state.mode !== 'turbo') return
      const expected = this.#effortFor(state.gear)
      if (expected === 'inherit') return
      const value = typeof observed === 'string' ? observed : undefined
      this.#caps.observedEffort = value
      const matches = value === expected
      this.#caps.reasoningEffort = matches
      if (!matches && !this.#effortMismatchReported) {
        this.#effortMismatchReported = true
        this.#ctx.logger?.warn(
          'dsh-turbo: reasoningEffort "%s" was configured but the request header carries "%s"; another agent/request listener owns that field',
          expected,
          value ?? '(none)',
        )
      }
      return
    }
    if (type === 'turn/end') {
      const turn = turnOf(data)
      if (turn === undefined) return
      const record = this.#metrics.endTurn(sessionId, turn)
      if (record !== undefined) {
        this.#evidence.write({
          event: 'turn-end',
          session: sessionId,
          turn,
          mode: record.mode,
          latencyMs: record.endedAt - record.startedAt,
          steps: record.steps,
          toolCalls: record.toolCalls,
          verificationObserved: record.verification,
        })
      }
    }
  }

  /** Attach one agent-scoped request listener that lowers reasoning effort. */
  #attachEffort(agent: AgentLike | undefined): void {
    const agentCtx = agent?.ctx
    if (agent === undefined || agentCtx === undefined) {
      this.#caps.effortUnavailable = true
      return
    }
    if (this.#effortHooks.has(agent.id)) return
    const sessionId = agent.session?.id ?? agent.id
    // `prepend: true` is load-bearing. The shipped model-selection listener
    // (`@deepseek-ai/dsh-agent`) sits downstream of every plugin and *strips*
    // any inherited `reasoningEffort` before re-applying the selected route's
    // own effort. Registering last would mean being overwritten; registering
    // first means this listener sees that final config and rewrites it after.
    const disposeRequest = agentCtx.on('agent/request', (async (
      _payload: { turn?: number; step?: number },
      next: () => Promise<Record<string, unknown>>,
    ) => {
      const config = await next()
      const state = this.#store.get(sessionId)
      if (state.mode !== 'turbo') return config
      const effort = this.#effortFor(state.gear)
      if (effort === 'inherit') return config
      return { ...config, reasoningEffort: effort }
    }) as never, { prepend: true })

    // The route owns its own vocabulary: `minimal`/`medium` are valid ids but
    // not for every adapter. A refused effort must not kill the turn, so the
    // refusal disables the lever for this Agent and asks the loop to retry.
    const disposeError = agentCtx.on('agent/request-error', (async (
      payload: { failure?: { code?: string; message?: string } },
      next: () => Promise<unknown>,
    ) => {
      const failure = payload?.failure
      if (failure?.code !== 'UNSUPPORTED_REASONING_EFFORT') return next()
      this.#disableEffort(agent.id, failure.message ?? 'the route refused the configured reasoning effort')
      return { kind: 'retry' }
    }) as never)

    this.#caps.effortUnavailable = false
    let disposed = false
    let detachDisposed: Disposer = () => {}
    const cleanup = (): void => {
      if (disposed) return
      disposed = true
      this.#effortHooks.delete(agent.id)
      try {
        disposeRequest()
      } finally {
        try {
          disposeError()
        } finally {
          detachDisposed()
        }
      }
    }
    detachDisposed = this.#ctx.on('agent/disposed', ((payload: { agent?: AgentLike }) => {
      if (payload?.agent?.id !== agent.id) return
      cleanup()
    }) as never)
    this.#effortHooks.set(agent.id, cleanup)
  }

  /** Withdraw the lever after the route refused it, and say so honestly. */
  #disableEffort(agentId: string, reason: string): void {
    this.#caps.reasoningEffort = false
    this.#caps.effortError = reason
    this.#effortMismatchReported = true
    this.#ctx.logger?.warn('dsh-turbo: reasoning effort disabled for agent "%s": %s', agentId, reason)
    this.#evidence.write({
      event: 'effort-disabled',
      session: agentId,
      configured: `${this.#config.reasoningEffort}/${this.#config.maxReasoningEffort}`,
      reason,
    })
    this.#effortHooks.get(agentId)?.()
  }

  /** Resolve the request-level lever for the selected Turbo gear. */
  #effortFor(gear: 'fast' | 'max'): TurboConfig['reasoningEffort'] {
    return gear === 'max' ? this.#config.maxReasoningEffort : this.#config.reasoningEffort
  }
}

function turnOf(data: Record<string, unknown>): number | undefined {
  const turn = data.turn
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
}
