/**
 * Plugin entry (Host half). The bundle patch inserts the row `name: dsh-turbo`,
 * which the loader resolves to this module's `apply`.
 *
 * @module dsh-turbo
 */

export { apply, inject, name } from './host/plugin.js'
export { resolveConfig, dshHome } from './host/plugin.js'
export { TurboSessionStore, isSessionId, parseGear, parseMode } from './host/session-store.js'
export { TurboMetrics, looksLikeVerification } from './host/metrics.js'
export { RuntimeAdapter } from './host/runtime-adapter.js'
export { EvidenceLog } from './host/evidence.js'
export { PLUGIN_NAME, PLUGIN_VERSION } from './version.js'
export { renderTurboPolicy, TURBO_SECTION_NAME, TURBO_POLICY_MARKER } from './prompts/turbo-policy.js'
export { DEFAULT_POLICY, TURBO_POLICY, TURBO_MAX_POLICY, policyFor, isTurbo } from './shared/policies.js'
