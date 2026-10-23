/**
 * Client half of DSH Turbo.
 *
 * Loading contract (verified against DSH 0.2.0-rc.2):
 * - `package.json` declares `dsh.client.platform: 'web'` and `exports['./client']`;
 * - the bundle is served by `@deepseek-ai/dsh-client-modules` and materialized
 *   as a Cordis plugin that exports `inject` + `apply(ctx)`;
 * - the only module requests are the platform baseline (`react`,
 *   `react/jsx-runtime`), so `dsh.client.external` stays empty.
 *
 * The toggle itself lives in `turbo-toggle.tsx`; this file owns registration,
 * the scoped stylesheet and the locale dictionaries.
 *
 * @module dsh-turbo/client
 */

import { NS, TURBO_CSS, TurboToggle } from './turbo-toggle.js'

/** Client services used: slots for the composer control, locale for copy. */
export const inject = ['slots', 'locale']

/** Slot the control occupies: compact controls before the submit action. */
const SLOT = 'conversation.input.right'

/** One-scoped stylesheet tag per plugin, mirroring the official plugins. */
const STYLE_ID = 'dsh-turbo/turbo.css'

/** Simplified Chinese copy (key-set source of truth). */
const zh = {
  'label.off': 'Turbo',
  'label.on': '⚡ Turbo ON',
  'label.loading': 'Turbo',
  'label.switching': 'Switching…',
  'label.unavailable': 'Turbo unavailable',
  'title.off': '本会话为默认执行模式 — 点击切换为极速模式',
  'title.on': '本会话已开启极速模式 — 点击恢复默认执行模式',
  'title.unavailable': '无法连接 Turbo Host 桥接',
  'details.open': 'Turbo 效果说明',
  'details.close': '关闭',
  'details.title': 'Turbo 能做什么',
  'details.intro': '让任务少走弯路，更快完成。',
  'details.flow.value': '约 20%',
  'details.flow.label': '减少执行流程',
  'details.speed.value': '约 1.5×',
  'details.speed.label': '提升完成速度',
  'details.caveat': '参考当前实测，实际效果会随任务和模型变化。',
  'details.try': '欢迎做个小测试：用同一任务分别开启和关闭 Turbo，对比耗时与 Token 用量。',
  'error.conflict': '另一个标签页已修改，显示 Host 的当前值',
  'error.offline': '无法连接 Host — 未修改 Turbo',
  'error.invalid': 'Host 拒绝了该请求',
  'error.generic': '切换 Turbo 失败',
}

/** English copy, complete against the zh key set. */
const en: Record<keyof typeof zh, string> = {
  'label.off': 'Turbo',
  'label.on': '⚡ Turbo ON',
  'label.loading': 'Turbo',
  'label.switching': 'Switching…',
  'label.unavailable': 'Turbo unavailable',
  'title.off': 'This session uses the default execution mode — click for Turbo',
  'title.on': 'Turbo is on for this session — click to restore the default mode',
  'title.unavailable': 'The Turbo host bridge is unreachable',
  'details.open': 'About Turbo results',
  'details.close': 'Close',
  'details.title': 'What Turbo does',
  'details.intro': 'Helps tasks take a more direct path and finish faster.',
  'details.flow.value': 'about 20%',
  'details.flow.label': 'fewer execution steps',
  'details.speed.value': 'about 1.5×',
  'details.speed.label': 'faster completion',
  'details.caveat': 'Based on current measurements; results vary by task and model.',
  'details.try': 'Try a quick test: run the same task once with Turbo on and once off, then compare time and token usage.',
  'error.conflict': 'Another tab changed this session; showing the Host value',
  'error.offline': 'Host unreachable — Turbo not changed',
  'error.invalid': 'The Host rejected the request',
  'error.generic': 'Turbo switch failed',
}

/** The Cordis client plugin's entry point. */
export function apply(ctx: {
  slots?: { inject?: (name: string, factory: () => unknown) => unknown; register?: (options: Record<string, unknown>, component: unknown) => unknown }
  locale?: { register?: (ns: string, dictionaries: Record<string, unknown>) => unknown; bind?: (ns: string) => (key: string) => string }
  effect?: (fn: () => (() => void) | void, label?: string) => unknown
  logger?: { warn?: (...args: unknown[]) => void }
}): void {
  installStyles(ctx)

  if (typeof ctx.locale?.register === 'function') {
    try {
      ctx.locale.register(NS, { zh, en })
    } catch (error) {
      ctx.logger?.warn?.('dsh-turbo: locale registration failed: %o', error)
    }
  }

  const slots = ctx.slots
  if (typeof slots?.inject !== 'function' || typeof slots.register !== 'function') {
    ctx.logger?.warn?.('dsh-turbo: the client slot service is unavailable; the toggle cannot be registered')
    return
  }

  // Slot declaration order is a load-order artifact: `slots.inject` waits for
  // the parent entry to declare `conversation.input.right` before registering.
  slots.inject(SLOT, () => slots.register?.({
    name: SLOT,
    kind: 'list',
    id: 'dsh-turbo',
    order: 10,
    locale: NS,
    // The slot's session binding is the only Session identity this control
    // needs: the Host validates it again on every read and write.
    inject: (sessionId?: string) => ({ turboSessionId: sessionId }),
  }, TurboToggle))
}

/** Inject the scoped stylesheet exactly once per document. */
function installStyles(ctx: { logger?: { warn?: (...args: unknown[]) => void } }): void {
  if (typeof document === 'undefined') return
  try {
    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
    const tag = document.createElement('style')
    tag.dataset['plugin'] = 'dsh-turbo'
    tag.dataset['pluginCss'] = STYLE_ID
    tag.textContent = TURBO_CSS
    document.head.appendChild(tag)
  } catch (error) {
    ctx.logger?.warn?.('dsh-turbo: stylesheet injection failed: %o', error)
  }
}

export { TurboToggle, NS, TURBO_CSS }
export { TurboController, DEFAULT_BASE_PATH } from './turbo-controller.js'
export type { TurboToggleProps } from './turbo-toggle.js'
export const SlotName = SLOT
