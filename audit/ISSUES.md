# dsh-turbo audit — 0.2.2

Generated 2026-10-23T22:10:50+08:00 · git `be07e50` · DSH 0.2.0-rc.2 (desktop)

> Generated from `audit/issues.json` by `node scripts/check-issues.mjs --markdown audit/ISSUES.md`. Do not edit by hand.

## Gates

| gate | result | command |
|---|---|---|
| typecheck | pass | `pnpm exec tsc --noEmit` |
| build-freshness | pass | `node scripts/build.mjs --check` |
| unit-tests | pass | `node --test tests/*.test.mjs` |
| live-host-bridge | fail | `GET http://127.0.0.1:19387/api/dsh-turbo/health` |
| installer-script | pass | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile desktop` |

## Issues

| id | severity | status | title |
|---|---|---|---|
| TURBO-001 | high | fixed | A version update deactivates the row until the process restarts |
| TURBO-002 | high | open | No reproducible end-to-end speedup has been demonstrated |
| TURBO-003 | medium | fixed | The fast and max gears currently select the same reasoning effort |
| TURBO-004 | medium | open | The reasoning-effort lever is applied but its effect is not observable in metrics |
| TURBO-005 | medium | documented | Verification detection recognises commands, not outcomes |
| TURBO-006 | low | open | In-flight turns are invisible in the metrics panel |
| TURBO-007 | low | accepted | The toggle polls the bridge every 2.5 s |
| TURBO-008 | low | open | Narrow-screen layout is only guarded by CSS |
| TURBO-009 | medium | open | Only DSH 0.2.0-rc.2 was actually exercised |
| TURBO-010 | high | fixed | install.ps1 crashed under Windows PowerShell 5.1 |
| TURBO-011 | medium | fixed | An unsupported reasoning effort could fail entire turns |
| TURBO-012 | medium | fixed | Bare pnpm audit/issues commands ran package-manager commands instead of the issue gate |

### TURBO-001 — A version update deactivates the row until the process restarts

- severity: **high** · status: fixed · category: runtime-activation
- recommendation: Done: unknown keys are warned and ignored, while invalid values for known keys still fail loudly. (effort S, risk low)
- workaround: One restart is still required to load this fix into a process already running the older module.

Cordis/Node cache modules by resolved path, so a running process may keep the old module while the profile gains new config keys. resolveConfig now warns and ignores unknown keys, preventing future config-first updates from deactivating the row.

Evidence:
- GOOD: GET /api/dsh-turbo/health -> 200 with version 0.1.0 before the update
- BAD:  GET /api/dsh-turbo/health -> 401 after the profile recomposed with the 0.2.1 patch
- config keys in cordis.patch.yml known only to 0.2.1: maxReasoningEffort, defaultGear
- fixed: src/host/plugin.ts resolveConfig accepts an onUnknown callback and continues with known keys
- fixed: apply logs ignored keys through the Cordis logger

Files: `src/host/plugin.ts`, `cordis.patch.yml`

### TURBO-002 — No reproducible end-to-end speedup has been demonstrated

- severity: **high** · status: open · category: product-claim
- recommendation: Run --repeat 3 or higher over a larger task set before making any speed claim; report pass rate next to latency. (effort M, risk none)
- workaround: Keep Turbo OFF by default (current defaultMode: default) and let users decide per session.

Two interleaved 20-task sweeps produced opposite signs at the median (-35% in sweep 1, +12% in sweep 2), and task-level deltas ranged -78% to +257%. The composition mounts no optional stage Turbo can remove, so the policy only nudges model behaviour.

Evidence:
- PERFORMANCE.md section 2 (sweep 1): turbo median 28 952 ms vs default 44 636 ms, turbo 7/9 passed vs default 9/9
- PERFORMANCE.md section 3 (sweep 2): turbo median 33 638 ms vs default 29 980 ms, turbo 19/20 passed vs default 18/19
- benchmark/smoke-three-arm-keep.md: single task, fast -8.3%, max -9.2%
- benchmark/paired-ui-sample.json: one paired UI sample, -29.2%, different task, single run, token figure includes cache reads
- PERFORMANCE.md section 4.3: sum-js repeat 3 passed 9/9; Fast median +32.4% slower, Max median -8.9% but mean +16.8% slower
- PERFORMANCE.md section 4.3: multi-file complete pair had Fast +10.2% and Max +22.4%; Max passed only 2/4 runs

Files: `PERFORMANCE.md`, `scripts/benchmark.mjs`, `benchmark/tasks.json`

### TURBO-003 — The fast and max gears currently select the same reasoning effort

- severity: **medium** · status: fixed · category: configuration
- recommendation: Done: maxReasoningEffort is high and the benchmark patch preserves the distinction. (effort S, risk low)
- workaround: None. Re-run the three-arm benchmark because earlier Fast/Max numbers used equal effort.

Fast now uses low effort and Max uses high effort. The gears remain different in policy text and now also select distinct request effort.

Evidence:
- cordis.patch.yml: reasoningEffort: low
- fixed: cordis.patch.yml sets maxReasoningEffort: high
- fixed: scripts/benchmark.mjs pins Fast=low and Max=high through the same plugin config

Files: `cordis.patch.yml`, `src/host/runtime-adapter.ts`

### TURBO-004 — The reasoning-effort lever is applied but its effect is not observable in metrics

- severity: **medium** · status: open · category: measurement
- recommendation: Find a proxy metric that actually moves (output tokens, first-token latency, or wall clock on a reasoning-heavy task), or confirm the provider reports reasoning usage at all. (effort M, risk none)
- workaround: Compare wall clock and output tokens, not reasoningTokens.

The request header really does carry the configured effort (verified after the prepend fix), yet every arm reports reasoningTokens 0, so nothing proves the lever reduces thinking or latency.

Evidence:
- session log request/header config: {"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"low"}
- benchmark/smoke-three-arm-keep.md: reasoning tok = 0 for default, fast and max
- evidence.jsonl confirms Max reasoningEffort=high on every pre-step, but formal-sum-js-3x still reports reasoningTokens=0 for all 9 runs

Files: `src/host/runtime-adapter.ts`, `scripts/benchmark.mjs`

### TURBO-005 — Verification detection recognises commands, not outcomes

- severity: **medium** · status: documented · category: honesty
- recommendation: Keep the label as an observation and state it in the UI tooltip and README ('a command was attempted, not that it passed'). (effort S, risk none)
- workaround: Read the session log's tool/result isError for outcome.

The 'verification ran' metric matches shell command text against test/build/lint patterns. It proves a command was attempted, never that it succeeded, and it is presented next to metrics that do imply outcomes.

Evidence:
- src/host/metrics.ts VERIFICATION_COMMAND regex
- src/host/metrics.ts looksLikeVerification() is driven by tool/call arguments only
- UI row label: 'Verification ran' / '是否执行了测试'

Files: `src/host/metrics.ts`, `src/client/turbo-toggle.tsx`

### TURBO-006 — In-flight turns are invisible in the metrics panel

- severity: **low** · status: open · category: measurement
- recommendation: Expose the live turn (mode, steps so far, elapsed) separately from completed-turn aggregates. (effort S, risk low)
- workaround: Read evidence.jsonl turn-end lines directly.

Session metrics summarise completed turns only, so during the first or current turn the panel shows 'turns 0' and dashes.

Evidence:
- src/host/metrics.ts summary() returns nulls when no completed record exists
- Live probe during an active turn returned turns=0, all metrics null

Files: `src/host/metrics.ts`, `src/host/runtime-adapter.ts`

### TURBO-007 — The toggle polls the bridge every 2.5 s

- severity: **low** · status: accepted · category: efficiency
- recommendation: Only worth fixing with a gateway event; keep polling until then. (effort L, risk low)
- workaround: None needed.

Cross-tab convergence is achieved by polling plus the revision guard rather than a pushed event.

Evidence:
- src/client/turbo-toggle.tsx POLL_MS = 2500
- src/host/plugin.ts revision guard returns 409 on a stale write

Files: `src/client/turbo-toggle.tsx`

### TURBO-008 — Narrow-screen layout is only guarded by CSS

- severity: **low** · status: open · category: ui
- recommendation: Verify at ~380 px composer width and screenshot it. (effort S, risk none)
- workaround: None.

A media query collapses the ON label to the bolt glyph below 640 px, but it has not been verified in a real narrow window.

Evidence:
- src/client/turbo-toggle.tsx TURBO_CSS @media (max-width:640px)

Files: `src/client/turbo-toggle.tsx`

### TURBO-009 — Only DSH 0.2.0-rc.2 was actually exercised

- severity: **medium** · status: open · category: compatibility
- recommendation: Run the compatibility suite against each release before widening the declared range. (effort M, risk none)
- workaround: Pin the DSH version in deployments.

The manifest declares dsh.engines >=0.2.0-rc.1 and marks 0.2.0-rc.2 as tested; every other version is an unverified claim. The plugin leans on observed, not documented, shapes (slot names, hook payload fields, asar layout).

Evidence:
- package.json dsh.engines + dsh.compatibility
- compatibility-report.md sections 2 and 3 cite source lines from 0.2.0-rc.2 only
- tests/compatibility.test.mjs encodes 0.2.0-rc.2 facts

Files: `package.json`, `tests/compatibility.test.mjs`

### TURBO-010 — install.ps1 crashed under Windows PowerShell 5.1

- severity: **high** · status: fixed · category: tooling
- recommendation: Done: resolve defaults after binding, test the asar file, prefer pnpm and verify from the profile manifest, ASCII + UTF-8 BOM output, health probe with retries. (effort S, risk none)
- workaround: Use the fixed scripts.

Four defects: $MyInvocation.MyCommand.Path is empty inside a param() default; app.asar was treated as a directory; a GUI-subsystem executable was not awaited so $LASTEXITCODE was unset; non-ASCII bullets were mis-decoded as ANSI.

Evidence:
- before: Split-Path : cannot bind argument to parameter 'Path' because it is null (install.ps1:33)
- before: 'npm add failed with exit code ' with an empty code
- before: mojibake 鈥? instead of bullet glyphs
- after: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -Profile desktop -> exit 0
- after: both scripts parse with 0 errors and contain 0 non-ASCII characters

Files: `scripts/install.ps1`, `scripts/uninstall.ps1`

### TURBO-011 — An unsupported reasoning effort could fail entire turns

- severity: **medium** · status: fixed · category: configuration
- recommendation: Done: route refusal disables the lever, writes an effort-disabled evidence line, and the capability row explains it. (effort S, risk none)
- workaround: Keep reasoningEffort at 'inherit' until a route-supported value is chosen.

The shipped DeepSeek Messages adapter accepts only off|low|high|max. A configured 'minimal' made every Turbo turn end with UNSUPPORTED_REASONING_EFFORT before the self-healing path existed.

Evidence:
- before: dsh: UNSUPPORTED_REASONING_EFFORT: provider "deepseek-official" model "deepseek-flash" does not support reasoning effort "minimal"
- adapter source: dsh-llm-deepseek accepted set [off, low, high, max]
- after: agent/request-error handler disables the lever for that agent and returns { kind: 'retry' }
- after: probe with reasoningEffort low -> request/header carries low, run exits 0

Files: `src/host/runtime-adapter.ts`, `src/host/plugin.ts`

### TURBO-012 — Bare pnpm audit/issues commands ran package-manager commands instead of the issue gate

- severity: **medium** · status: fixed · category: tooling
- recommendation: Done: use pnpm run check:issues for validation/rendering and pnpm run check:issues:strict for the high-severity gate. (effort S, risk none)
- workaround: Use node scripts/check-issues.mjs directly on older checkouts.

pnpm reserves both audit and issues. Package scripts with those names require pnpm run, while the bare commands reported dependency or repository information and never validated audit/issues.json.

Evidence:
- observed: pnpm audit printed 'No known vulnerabilities found' without rendering audit/ISSUES.md
- observed: pnpm issues printed the repository Issues URL without rendering audit/ISSUES.md
- fixed: package scripts are named check:issues and check:issues:strict
- verified: pnpm run check:issues runs check-issues.mjs and refreshes the Markdown view

Files: `package.json`, `scripts/check-issues.mjs`, `audit/issues.json`
