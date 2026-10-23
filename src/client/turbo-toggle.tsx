/**
 * The Turbo toggle: one compact control registered into the official
 * `conversation.input.right` list slot (compact controls before the composer
 * submit action).
 *
 * Why not `conversation.input.activity`: that slot is `kind: 'single'` and the
 * composer renders the submit/stop button into it. Occupying it would replace
 * the send button (or throw `single slot ... already has a registration`),
 * so the brief's first preference is recorded as unimplementable in
 * compatibility-report.md §2 and this slot is used instead.
 *
 * Behaviour contract (brief §6.2):
 * - switching never clears the conversation, recreates the Session, or sends a
 *   message;
 * - the control only ever shows a mode the Host confirmed;
 * - a failed write reverts to the previous mode and says why;
 * - two tabs converge through the revision guard, and a stale tab shows the
 *   Host's value rather than fighting it.
 *
 * @module dsh-turbo/client/turbo-toggle
 */

import * as React from 'react'
import type { TurboCapability, TurboMode, TurboSessionMetrics } from '../shared/types.js'
import { TurboController, emptyMetrics } from './turbo-controller.js'

/** Locale namespace owned by this plugin. */
export const NS = 'turbo'

/** Bridge prefix (must match the Host half's route prefix). */
export const BASE_PATH = '/api/dsh-turbo'

/** Poll cadence while the tab is visible. */
const POLL_MS = 2500

/** Props the Host-side registration supplies. */
export interface TurboToggleProps {
  /** Session this control belongs to (from the slot's session binding). */
  turboSessionId?: string
  /** Translator bound to `turbo` by the locale seat, when available. */
  t?: (key: string, params?: Record<string, string | number>) => string
}

type Status = 'loading' | 'ready' | 'unavailable'

interface Snapshot {
  readonly mode: TurboMode
  readonly revision: number
  readonly capabilities: readonly TurboCapability[]
  readonly metrics: TurboSessionMetrics
}

const INITIAL: Snapshot = {
  mode: 'default',
  revision: 0,
  capabilities: [],
  metrics: emptyMetrics(),
}

/** The control. */
export function TurboToggle(props: TurboToggleProps): React.ReactElement {
  const sessionId = props.turboSessionId
  const controllerRef = React.useRef<TurboController | undefined>(undefined)
  const [status, setStatus] = React.useState<Status>('loading')
  const [snapshot, setSnapshot] = React.useState<Snapshot>(INITIAL)
  const [switching, setSwitching] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const [anchor, setAnchor] = React.useState<{ bottom: number; right: number } | null>(null)
  const chipRef = React.useRef<HTMLButtonElement | null>(null)
  const aliveRef = React.useRef(true)

  const tr = React.useCallback((key: string, fallback: string): string => {
    const t = props.t
    if (typeof t !== 'function') return fallback
    try {
      const value = t(key)
      return typeof value === 'string' && value !== '' && value !== key ? value : fallback
    } catch {
      return fallback
    }
  }, [props.t])

  React.useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // One controller per Session binding; a Session switch replaces it.
  React.useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      setStatus('unavailable')
      return
    }
    const controller = new TurboController(sessionId, { basePath: BASE_PATH })
    controllerRef.current = controller
    let cancelled = false

    const load = async (): Promise<void> => {
      const result = await controller.read()
      if (cancelled || !aliveRef.current) return
      if (result.kind === 'ok') {
        setSnapshot({
          mode: result.view.state.mode,
          revision: result.view.state.revision,
          capabilities: result.view.capabilities,
          metrics: result.view.metrics,
        })
        setStatus('ready')
        setError(null)
        return
      }
      if (result.kind === 'offline') {
        // The Host bridge is unreachable: never claim a mode we cannot confirm.
        setStatus('unavailable')
        return
      }
      setStatus('unavailable')
    }

    void load()

    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void load()
    }, POLL_MS)
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void load()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sessionId])

  // Keep a fixed-position details panel inside the viewport and un-clipped by
  // the composer card's overflow.
  const placePanel = React.useCallback(() => {
    const chip = chipRef.current
    if (chip === null || typeof window === 'undefined') return
    const rect = chip.getBoundingClientRect()
    setAnchor({
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
      right: Math.max(8, window.innerWidth - rect.right),
    })
  }, [])

  React.useEffect(() => {
    if (!detailsOpen) return
    placePanel()
    const onResize = (): void => placePanel()
    // Closing on Escape or an outside press is what every other popover in the
    // composer does; a panel that only closes via its own button feels stuck.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDetailsOpen(false)
    }
    const onPointer = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (chipRef.current?.closest('.dshTurbo_root')?.contains(target) === true) return
      setDetailsOpen(false)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
    }
  }, [detailsOpen, placePanel])

  const onToggle = React.useCallback((): void => {
    const controller = controllerRef.current
    if (controller === undefined || switching) return
    if (status !== 'ready') return
    const previous = snapshot
    const target: TurboMode = previous.mode === 'turbo' ? 'default' : 'turbo'
    setSwitching(true)
    setError(null)
    // Optimistic *display* only: the chip shows the target while the request is
    // in flight, and reverts unless the Host confirms it.
    setSnapshot({ ...previous, mode: target })
    void controller.write(target, previous.revision).then((result) => {
      if (!aliveRef.current) return
      setSwitching(false)
      if (result.kind === 'ok') {
        setSnapshot({
          mode: result.view.state.mode,
          revision: result.view.state.revision,
          capabilities: result.view.capabilities,
          metrics: result.view.metrics,
        })
        setStatus('ready')
        return
      }
      if (result.kind === 'conflict') {
        setSnapshot({
          mode: result.view.state.mode,
          revision: result.view.state.revision,
          capabilities: previous.capabilities,
          metrics: previous.metrics,
        })
        setError(tr('error.conflict', 'Another tab changed this session; showing the Host value.'))
        return
      }
      setSnapshot(previous)
      setError(
        result.kind === 'offline'
          ? tr('error.offline', 'Host unreachable — Turbo not changed.')
          : result.kind === 'invalid'
            ? tr('error.invalid', 'Host rejected the request.')
            : tr('error.generic', 'Turbo switch failed.'),
      )
    }, () => {
      if (!aliveRef.current) return
      setSwitching(false)
      setSnapshot(previous)
      setError(tr('error.generic', 'Turbo switch failed.'))
    })
  }, [snapshot, status, switching, tr])

  const mode = snapshot.mode
  const on = mode === 'turbo'
  const label = status === 'loading'
    ? tr('label.loading', 'Turbo')
    : status === 'unavailable'
      ? tr('label.unavailable', 'Turbo unavailable')
      : switching
        ? tr('label.switching', 'Switching…')
        : on
          ? tr('label.on', '⚡ Turbo ON')
          : tr('label.off', 'Turbo')

  const title = status === 'unavailable'
    ? tr('title.unavailable', 'Turbo host bridge unreachable')
    : on
      ? tr('title.on', 'Turbo is on for this session — click to return to the default execution mode')
      : tr('title.off', 'Turbo is off for this session — click for the low-latency execution mode')

  const className = [
    'dshTurbo_button',
    on && status === 'ready' ? 'dshTurbo_on' : '',
    status === 'unavailable' ? 'dshTurbo_unavailable' : '',
    switching ? 'dshTurbo_busy' : '',
  ].filter(Boolean).join(' ')

  return (
    <span className="dshTurbo_root">
      <button
        ref={chipRef}
        type="button"
        className={className}
        aria-pressed={status === 'ready' ? on : undefined}
        aria-label={title}
        title={title}
        disabled={status !== 'ready' || switching}
        onClick={onToggle}
        data-dsh-turbo-mode={status === 'ready' ? mode : 'unknown'}
      >
        <span className="dshTurbo_bolt" aria-hidden="true">{on && status === 'ready' ? '⚡' : ''}</span>
        <span className="dshTurbo_text">{label}</span>
      </button>
      <button
        type="button"
        className="dshTurbo_info"
        aria-label={tr('details.open', 'Turbo details')}
        aria-expanded={detailsOpen}
        title={tr('details.open', 'Turbo details')}
        disabled={status === 'unavailable'}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        ?
      </button>
      {error !== null && (
        <span className="dshTurbo_error" role="status" title={error}>{error}</span>
      )}
      {detailsOpen && anchor !== null && (
        <DetailsPanel
          tr={tr}
          anchor={anchor}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </span>
  )
}

interface DetailsPanelProps {
  readonly tr: (key: string, fallback: string) => string
  readonly anchor: { bottom: number; right: number }
  readonly onClose: () => void
}

function DetailsPanel({ tr, anchor, onClose }: DetailsPanelProps): React.ReactElement {
  return (
    <div
      className="dshTurbo_panel"
      role="dialog"
      aria-label={tr('details.title', 'What Turbo does')}
      style={{ bottom: `${anchor.bottom}px`, right: `${anchor.right}px` }}
    >
      <div className="dshTurbo_panelHead">
        <strong>{tr('details.title', 'What Turbo does')}</strong>
        <button type="button" className="dshTurbo_close" onClick={onClose} aria-label={tr('details.close', 'Close')}>×</button>
      </div>
      <p className="dshTurbo_intro">
        {tr('details.intro', 'Helps tasks take a more direct path and finish faster.')}
      </p>
      <div className="dshTurbo_benefits">
        <div className="dshTurbo_benefit">
          <strong className="dshTurbo_metric">{tr('details.flow.value', 'about 20%')}</strong>
          <span>{tr('details.flow.label', 'fewer execution steps')}</span>
        </div>
        <div className="dshTurbo_benefit">
          <strong className="dshTurbo_metric">{tr('details.speed.value', 'about 1.5×')}</strong>
          <span>{tr('details.speed.label', 'faster completion')}</span>
        </div>
      </div>
      <p className="dshTurbo_caveat">
        {tr('details.caveat', 'Based on current measurements; results vary by task and model.')}
      </p>
      <p className="dshTurbo_try">
        {tr('details.try', 'Try a quick test: run the same task once with Turbo on and once off, then compare time and token usage.')}
      </p>
    </div>
  )
}

/** Scoped stylesheet; theme tokens only, no global overrides. */
export const TURBO_CSS = `
.dshTurbo_root{display:inline-flex;align-items:center;gap:4px;min-width:0;position:relative}
.dshTurbo_button{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;transition:background-color .12s,color .12s;white-space:nowrap}
.dshTurbo_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTurbo_button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshTurbo_button:disabled{cursor:default}
.dshTurbo_on{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.dshTurbo_on:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-state-business-primary) 8%);color:var(--dsw-alias-state-business-primary)}
.dshTurbo_unavailable{color:var(--dsw-alias-label-tertiary);opacity:.7;cursor:not-allowed}
.dshTurbo_busy{opacity:.65}
.dshTurbo_bolt{display:inline-flex;width:0;overflow:hidden}
.dshTurbo_on .dshTurbo_bolt,.dshTurbo_button:not(.dshTurbo_on) .dshTurbo_bolt{width:0}
.dshTurbo_info{width:18px;height:18px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:1;cursor:pointer}
.dshTurbo_info:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTurbo_info:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshTurbo_error{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.dshTurbo_panel{position:fixed;z-index:60;box-sizing:border-box;width:280px;max-width:calc(100vw - 24px);padding:10px 12px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;line-height:18px}
.dshTurbo_panelHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:13px}
.dshTurbo_close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:16px;line-height:16px;cursor:pointer;padding:0 2px}
.dshTurbo_close:hover{color:var(--dsw-alias-label-primary)}
.dshTurbo_intro{margin:0 0 10px;color:var(--dsw-alias-label-secondary)}
.dshTurbo_benefits{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.dshTurbo_benefit{display:flex;min-width:0;flex-direction:column;gap:1px;padding:9px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-secondary)}
.dshTurbo_metric{color:var(--dsw-alias-state-business-primary);font-size:18px;line-height:22px;font-variant-numeric:tabular-nums}
.dshTurbo_caveat{margin:0 0 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dshTurbo_try{margin:0;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
@media (max-width:640px){
  .dshTurbo_button{padding:0 6px}
  .dshTurbo_on .dshTurbo_text{display:none}
  .dshTurbo_on .dshTurbo_bolt{width:auto}
  .dshTurbo_error{display:none}
}
`
