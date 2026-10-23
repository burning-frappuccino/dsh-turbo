/**
 * Structural views of the Cordis surface this plugin touches.
 *
 * dsh-turbo imports no `@deepseek-ai/*` package on purpose:
 * - a bundle row that imports a DSH package is pinned to that package's exact
 *   module identity inside the running host, which is what breaks third-party
 *   plugins across patch releases;
 * - everything this plugin needs is reachable through the `ctx` it is handed.
 *
 * These interfaces therefore describe *observed* shapes (verified against DSH
 * 0.2.0-rc.2 — see compatibility-report.md), not an exported DSH contract.
 *
 * @module dsh-turbo/host/cordis-surface
 */

/** A disposer returned by every Cordis registration. */
export type Disposer = () => void

/** Minimal `ctx.logger` surface (Cordis' console logger). */
export interface CordisLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  debug?(...args: unknown[]): void
}

/** One prompt section as accepted by `ctx.systemPrompt.section()`. */
export interface PromptSection {
  readonly name: string
  readonly order: number
  /** Static text, or a per-assembly resolver receiving `{ agent, scope }`. */
  readonly text: string | ((context: { agent?: AgentLike | undefined }) => string)
  readonly interpolate?: boolean
}

/** `ctx.systemPrompt` (`@deepseek-ai/dsh-system-prompt`). */
export interface SystemPromptService {
  section(section: PromptSection): Disposer
  getSectionOrder(name: string): number
}

/** The Session object reachable from an Agent (`agent.session`). */
export interface SessionLike {
  readonly id: string
}

/** The Agent object handed to `agent/*` hooks. */
export interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  /** Agent-scoped Context: registrations here live and die with the agent. */
  readonly ctx?: TurboContext
}

/** One Session-log event (`session/event`). */
export interface SessionEventLike {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: Record<string, unknown>
}

/** `ctx.webServer.register()` route shape. */
export interface HttpRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: unknown, res: unknown) => void | Promise<void>
}

/** Options accepted by `ctx.on` (`prepend` puts the listener first in the chain). */
export interface ListenerOptions {
  readonly prepend?: boolean
  readonly global?: boolean
}

/** A Cordis Context, described only by the members this plugin uses. */
export interface TurboContext {
  readonly logger?: CordisLogger
  /** `apply(ctx, config)` receives the row's config object. */
  readonly config?: unknown
  effect(fn: () => Disposer, label?: string): Disposer
  on(name: string, listener: (...args: never[]) => unknown, options?: ListenerOptions | boolean): Disposer
  inject?(deps: string[], callback: (ctx: TurboContext) => void): Disposer
  get?(name: string): unknown
  readonly systemPrompt?: SystemPromptService
  readonly webServer?: { register(route: HttpRoute): Disposer }
  readonly agents?: {
    get?(id: string): AgentLike | undefined
    list?(): AgentLike[]
  }
  readonly [service: string]: unknown
}

/** Typed helper: read an optional service off a context. */
export function service<T>(ctx: TurboContext, name: string): T | undefined {
  const value = (ctx as Record<string, unknown>)[name]
  return value === undefined || value === null ? undefined : (value as T)
}
