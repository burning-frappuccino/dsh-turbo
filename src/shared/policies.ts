/**
 * The policy engine: an internal design vocabulary mapped onto the DSH hooks
 * that actually exist (see compatibility-report.md).
 *
 * This interface is dsh-turbo's own contract; DSH publishes no API of this
 * shape. Every field states a *tendency* the runtime can express, plus one
 * hard invariant that must never be traded for latency.
 *
 * @module dsh-turbo/shared/policies
 */

import type { TurboMode } from './types.js'

/** One executable policy set. */
export interface ExecutionPolicy {
  /** Emit only the plan that guides immediate execution. */
  readonly minimalPlanning: boolean
  /** Prefer one implementation pass over iterative rewriting. */
  readonly preferSinglePass: boolean
  /** Do not open an optional review/reflection stage of its own. */
  readonly skipOptionalReview: boolean
  /**
   * Do not start optional tests, builds, formatters or linters. A task whose
   * stated acceptance criteria include a check keeps that check.
   */
  readonly skipOptionalTests: boolean
  /** Prefer the shortest path that finishes the task. */
  readonly preferLowLatency: boolean
  /** Never removable: permissions, approval, sandbox, and necessary checks. */
  readonly preserveMandatoryChecks: true
}

/** Turbo ON: the fast path. */
export const TURBO_POLICY: ExecutionPolicy = Object.freeze({
  minimalPlanning: true,
  preferSinglePass: true,
  skipOptionalReview: true,
  skipOptionalTests: true,
  preferLowLatency: true,
  preserveMandatoryChecks: true,
})

/**
 * Turbo OFF: DSH's own behaviour, expressed as "add nothing".
 *
 * The plugin still contributes zero prompt text and registers no behavioral
 * difference; this constant exists so the client can report what is active
 * without inventing a second code path.
 */
export const DEFAULT_POLICY: ExecutionPolicy = Object.freeze({
  minimalPlanning: false,
  preferSinglePass: false,
  skipOptionalReview: false,
  skipOptionalTests: false,
  preferLowLatency: false,
  preserveMandatoryChecks: true,
})

/** Resolve the policy for a mode. */
export function policyFor(mode: TurboMode): ExecutionPolicy {
  return mode === 'turbo' ? TURBO_POLICY : DEFAULT_POLICY
}

/**
 * Whether a session runs the turbo policy. Anything other than the explicit
 * `turbo` literal — including a future/unknown mode string read from an older
 * state file — falls back to the untouched default path.
 */
export function isTurbo(mode: unknown): boolean {
  return mode === 'turbo'
}
