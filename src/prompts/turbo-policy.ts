/**
 * The single prompt section this plugin contributes while a Session is in
 * Turbo mode.
 *
 * Design constraints:
 * - It is one ordered section in DSH's own assembly, not a competing system
 *   prompt: it renders to `''` whenever the Session is not in Turbo, so the
 *   default path is byte-identical to a harness without this plugin.
 * - It states tendencies only. Anything the runtime can actually enforce is
 *   enforced in `host/runtime-adapter.ts`, not asked for here.
 * - It is deliberately short: the section is re-sent on every step, so a long
 *   policy would buy latency with latency.
 *
 * @module dsh-turbo/prompts/turbo-policy
 */

import type { TurboGear } from '../shared/types.js'

/** Stable section name; scoped registrations shadow by name. */
export const TURBO_SECTION_NAME = 'turbo:execution-policy'

/** Marker phrase used by tests and by the evidence log. */
export const TURBO_POLICY_MARKER = 'TURBO EXECUTION MODE'

/**
 * The rendered section text.
 *
 * v2 (after the Phase 3 pilot): the v1 wording let the model treat every check
 * as optional, and two tasks that the default mode passed were shipped broken.
 * v2 keeps the latency goal but names the *cheapest proof* as part of finishing,
 * and makes the verification disclosure a concrete line instead of a tone.
 */
export function renderTurboPolicy(gear: TurboGear = 'fast'): string {
  const base = [
    TURBO_POLICY_MARKER,
    '',
    'Optimize for minimum wall-clock completion time.',
    '',
    'Plan briefly, then execute as soon as the necessary context is in hand. Do not re-derive facts you already have, do not re-read the same file, and do not compare equivalent options.',
    '',
    'Keep planning compact. Put implementation into tool calls instead of drafting it at length before acting.',
    '',
    'Prefer one complete implementation pass over incremental rewriting. Use parallel tool calls when the operations are independent; keep dependent steps in dependency order.',
    '',
    'Do not open optional review, reflection, or re-verification stages. Do not start full suites, builds, formatters, or linters that the user did not ask for and that the acceptance criteria do not require.',
    '',
    'Before you call a code change finished, run the single cheapest command that would catch a wrong result — one test file, one typecheck, or one script that exercises the change. That check is part of finishing the task, not an optional stage.',
    '',
    'Tool failures that block completion still get the minimal repair they need: a retry or a fix is part of finishing the task, not an optional stage.',
    '',
    'Deliver the result as soon as it is complete. End the reply with one line stating what you actually ran: `Verified: <the command or check>` or `Verified: none`. Never describe code as tested when no test ran.',
    '',
    'Mandatory permissions, approvals, sandbox rules, and checks are never skipped for speed.',
  ]
  if (gear === 'max') {
    base.splice(4, 0,
      'MAX GEAR: lower wall-clock latency is worth extra token and tool budget.',
      '',
      'Gather all likely-needed context up front. Launch every independent read, search, tool call, and available subagent in the same turn instead of serially. Parallel duplicate exploration is allowed only when the result can be checked cheaply; never duplicate a mutating or non-idempotent action.',
      '',
      'Keep dependent operations ordered. Use the extra breadth to finish sooner, not to add prose or ceremonial review.',
      '',
    )
  }
  return base.join('\n')
}
