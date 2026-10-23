#!/usr/bin/env node
/**
 * Default / Fast / Max benchmark harness.
 *
 * Design (see compatibility-report.md §7 for why this surface):
 * - one headless DSH run per measurement: `dsh --profile <bench> --json "<task>"`
 *   on the SAME 0.2.0 runtime the GUI uses;
 * - a fresh workspace per run, seeded from the task's `seed` so both arms start
 *   from identical bytes;
 * - the only differences between arms are the plugin mode, gear and its
 *   configured effort — same model, tools and safety;
 * - a rotating Latin-square order interleaves all three arms per task so cache
 *   warm-up and time-of-day drift do not consistently favour one arm.
 *
 * Measurements come from the runner's own event stream (not from reply length):
 * wall-clock, first-token latency, model steps, tool calls, tokens, whether a
 * verification command ran, and a machine-checked pass/fail.
 *
 * Usage:
 *   node scripts/benchmark.mjs --profile turbo-bench --limit 3
 *   node scripts/benchmark.mjs --profile turbo-bench --tasks sum-js,fix-offbyone
 *   node scripts/benchmark.mjs --profile turbo-bench --repeat 2 --out PERFORMANCE-OVERDRIVE.md
 */

import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const HARNESS = process.env.DSH_EXE ?? join(
  process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe',
)
const CLI = process.env.DSH_CLI ??
  join(dirname(HARNESS), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
if (args.includes('--help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0])
  process.exit(0)
}
const profile = arg('--profile', 'turbo-bench')
const catalogFile = arg('--catalog', 'benchmark/tasks.json')
const limit = Number(arg('--limit', '0'))
const only = (arg('--tasks', '') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
const repeat = Number(arg('--repeat', '1'))
const outFile = arg('--out', '')
const keepWorkspaces = args.includes('--keep')
const requestedArms = (arg('--arms', 'default,fast,max') ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean)

const ARM_CONFIG = Object.freeze({
  default: { defaultMode: 'default', defaultGear: 'fast', reasoningEffort: 'low', maxReasoningEffort: 'high' },
  fast: { defaultMode: 'turbo', defaultGear: 'fast', reasoningEffort: 'low', maxReasoningEffort: 'high' },
  max: { defaultMode: 'turbo', defaultGear: 'max', reasoningEffort: 'low', maxReasoningEffort: 'high' },
})
const arms = [...new Set(requestedArms)]
if (arms.length < 1 || arms.some((arm) => ARM_CONFIG[arm] === undefined)) {
  console.error('--arms must contain values from default,fast,max')
  process.exit(1)
}

const catalogPath = resolve(root, catalogFile)
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
let tasks = catalog.tasks
if (only.length > 0) tasks = tasks.filter((task) => only.includes(task.id))
if (limit > 0) tasks = tasks.slice(0, limit)
if (tasks.length === 0) {
  console.error('no tasks selected')
  process.exit(1)
}

const runRoot = join(root, 'benchmark', 'runs')
mkdirSync(runRoot, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const results = []

// ── helpers ──────────────────────────────────────────────────────────────────

/** Write a `--patch` overlay that pins mode, gear and gear-specific effort. */
function patchFor(arm, index) {
  const config = ARM_CONFIG[arm]
  const file = join(runRoot, `patch-${arm}-${index}.yml`)
  writeFileSync(file, [
    '- id: dsh-turbo',
    '  name: dsh-turbo',
    '  config:',
    '    evidenceLog: true',
    `    storageDir: dsh-turbo-bench-${arm}`,
    `    defaultMode: ${config.defaultMode}`,
    `    defaultGear: ${config.defaultGear}`,
    `    reasoningEffort: ${config.reasoningEffort}`,
    `    maxReasoningEffort: ${config.maxReasoningEffort}`,
    '',
  ].join('\n'), 'utf8')
  return file
}

/** Run one headless task and fold its event stream into measurements. */
function runOne(task, arm, index, round, attempt = 1) {
  const workspace = join(runRoot, `${stamp}-${task.id}-${arm}-${index}-r${round}-a${attempt}`)
  mkdirSync(workspace, { recursive: true })
  for (const [name, content] of Object.entries(task.seed ?? {})) {
    writeFileSync(join(workspace, name), content, 'utf8')
  }
  const patch = patchFor(arm, index)
  const started = Date.now()
  const child = spawn(HARNESS, [
    '--expose-internals', CLI,
    '--profile', profile,
    '--patch', patch,
    '--json',
    task.prompt,
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_HOME: HOME,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // A one-shot run can stall on a provider retry or a prompts-free approval
  // path; an unbounded harness would hang the whole measurement sweep.
  const timeoutMs = Number(arg('--timeout', '240000'))
  let timedOut = false
  const killer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  killer.unref?.()

  let stdout = ''
  let stderr = ''
  let firstContentAt = null
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    stdout += text
    if (firstContentAt === null && /"type":"(?:text|thinking)"/.test(text)) {
      firstContentAt = Date.now() - started
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

  return new Promise((resolveRun) => {
    child.on('close', (code) => {
      clearTimeout(killer)
      const wallMs = Date.now() - started
      const events = stdout.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      }).filter(Boolean)

      const steps = events.filter((event) => event.type === 'status' && event.phase === 'step_start').length
      const toolCalls = events.filter((event) => event.type === 'tool_call')
      const callsByStep = new Map()
      for (const event of toolCalls) {
        const step = Number.isFinite(event.step) ? event.step : null
        if (step === null) continue
        callsByStep.set(step, (callsByStep.get(step) ?? 0) + 1)
      }
      const callsPerStep = [...callsByStep.values()]
      const turnEnd = events.find((event) => event.type === 'status' && event.phase === 'turn_end')
      // The runner's projection uses `tool` + `input`; a provider outage shows up
      // as `dsh: TRANSPORT: …` on stderr with turnEnd.kind === 'error'. Those runs
      // measure the network, not the policy, so they are retried and then dropped.
      const toolName = (event) => String(event.tool ?? '')
      const toolInput = (event) => JSON.stringify(event.input ?? {})
      const transportFailed = turnEnd?.reason?.kind === 'error' || /transport failed|TRANSPORT/i.test(stderr)
      const usages = events.filter((event) => event.type === 'status' && event.usage).map((event) => event.usage)
      const usage = usages.reduce((sum, item) => ({
        inputTokens: sum.inputTokens + (item.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (item.outputTokens ?? 0),
        reasoningTokens: sum.reasoningTokens + (item.reasoningTokens ?? 0),
        cacheReadTokens: sum.cacheReadTokens + (item.cacheReadTokens ?? 0),
      }), { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 })
      const finalText = events.filter((event) => event.type === 'final').map((event) => event.text).join('')
      const sessionId = events.find((event) => event.type === 'session')?.sessionId

      const passed = checkTask(task, workspace)
      const result = {
        task: task.id,
        arm,
        index,
        round,
        wallMs,
        steps,
        toolCalls: toolCalls.length,
        maxCallsPerStep: callsPerStep.length === 0 ? null : Math.max(...callsPerStep),
        parallelToolSteps: callsPerStep.filter((count) => count > 1).length,
        toolEventKeys: [...new Set(toolCalls.flatMap((event) => Object.keys(event)))].sort(),
        toolNames: [...new Set(toolCalls.map(toolName))].filter(Boolean),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cacheReadTokens: usage.cacheReadTokens,
        firstTokenMs: firstContentAt,
        verificationObserved: toolCalls.some((event) => /(?:test|build|lint|tsc|vitest|pytest)/i.test(toolInput(event))),
        turnEnd: turnEnd?.reason?.kind ?? null,
        exitCode: code,
        passed,
        timedOut,
        transportFailed,
        sessionId: sessionId ?? null,
        finalChars: finalText.length,
        stderr: stderr.slice(0, 400),
      }
      if (!keepWorkspaces) rmSync(workspace, { recursive: true, force: true })
      resolveRun(result)
    })
  })
}

/** Machine-checked acceptance: the task's own assertion against the workspace. */
function checkTask(task, workspace) {
  const script = [
    "const assert = require('node:assert')",
    "const path = require('node:path')",
    `process.chdir(${JSON.stringify(workspace)})`,
    'let failed = false',
    'try {',
    `  ${task.check}`,
    '} catch (error) { failed = true; console.error(String(error && error.message)) }',
    'if (failed) process.exit(1)',
  ].join('\n')
  const file = join(workspace, '__check.mjs.cjs')
  try {
    writeFileSync(file, script, 'utf8')
    execFileSync(process.execPath, [file], { cwd: workspace, stdio: 'ignore', timeout: 20000 })
    return true
  } catch {
    return false
  } finally {
    try { rmSync(file, { force: true }) } catch { /* best effort */ }
  }
}

function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[index])
}
function mean(values) {
  return values.length === 0 ? null : Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * A provider transport failure is not a policy measurement. Retry it a couple
 * of times; a run that still fails is recorded with `excluded: true` and kept
 * out of the summary instead of silently counting as a Turbo (or default) loss.
 */
async function runWithRetry(task, arm, index, round) {
  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runOne(task, arm, index, round, attempt)
    if (result.timedOut) return { ...result, excluded: true, exclusionReason: 'timeout' }
    if (!result.transportFailed) return result
    if (attempt < attempts) {
      console.log(`transport failure, retrying (${attempt}/${attempts - 1})…`)
      await delay(5000)
      continue
    }
    return { ...result, excluded: true, exclusionReason: 'provider transport failure after retries' }
  }
  return undefined
}

// ── main loop ────────────────────────────────────────────────────────────────
console.log(`dsh-overdrive benchmark — profile=${profile} arms=${arms.join(',')} tasks=${tasks.length} repeat=${repeat}`)
console.log(`runtime: ${HARNESS}`)

for (let round = 1; round <= repeat; round += 1) {
  for (const [index, task] of tasks.entries()) {
    // Rotating Latin square: every arm occupies every order position.
    const offset = (index + round - 1) % arms.length
    const order = [...arms.slice(offset), ...arms.slice(0, offset)]
    for (const arm of order) {
      process.stdout.write(`[${round}.${index + 1}] ${task.id.padEnd(16)} ${arm.padEnd(8)} `)
      const result = await runWithRetry(task, arm, index, round)
      results.push(result)
      console.log(result.excluded === true
        ? `EXCLUDED (${result.exclusionReason})`
        : `wall=${result.wallMs}ms steps=${result.steps} tools=${result.toolCalls} pass=${result.passed ? 'y' : 'n'}`)
    }
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
const usable = results.filter((row) => row.excluded !== true)
const excluded = results.length - usable.length
const summary = {}
for (const arm of arms) {
  const rows = usable.filter((row) => row.arm === arm)
  const validRows = rows.filter((row) => row.passed)
  const wall = validRows.map((row) => row.wallMs)
  summary[arm] = {
    runs: rows.length,
    passed: validRows.length,
    successRate: rows.length === 0 ? null : Number((validRows.length / rows.length).toFixed(3)),
    validRuns: validRows.length,
    medianWallMs: pct(wall, 50),
    meanWallMs: mean(wall),
    p90WallMs: pct(wall, 90),
    meanSteps: mean(validRows.map((row) => row.steps)),
    meanToolCalls: mean(validRows.map((row) => row.toolCalls)),
    meanMaxCallsPerStep: mean(validRows.map((row) => row.maxCallsPerStep).filter((value) => value !== null)),
    parallelToolRuns: validRows.filter((row) => row.parallelToolSteps > 0).length,
    meanInputTokens: mean(validRows.map((row) => row.inputTokens)),
    meanOutputTokens: mean(validRows.map((row) => row.outputTokens)),
    meanReasoningTokens: mean(validRows.map((row) => row.reasoningTokens)),
    meanCacheReadTokens: mean(validRows.map((row) => row.cacheReadTokens)),
    medianFirstTokenMs: pct(validRows.map((row) => row.firstTokenMs).filter((value) => value !== null), 50),
    verificationRuns: validRows.filter((row) => row.verificationObserved).length,
    meanFinalChars: mean(validRows.map((row) => row.finalChars)),
  }
}

const pairedRounds = []
for (const task of tasks) {
  for (let round = 1; round <= repeat; round += 1) {
    const armRows = Object.fromEntries(arms.map((arm) => [
      arm,
      usable.find((result) => result.task === task.id && result.arm === arm && result.round === round),
    ]))
    if (!arms.every((arm) => armRows[arm]?.passed === true)) continue
    const row = { task: task.id, round, arms: {} }
    for (const arm of arms) {
      const result = armRows[arm]
      row.arms[arm] = {
        wallMs: result.wallMs,
        steps: result.steps,
        toolCalls: result.toolCalls,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        reasoningTokens: result.reasoningTokens,
        cacheReadTokens: result.cacheReadTokens,
      }
    }
    const baseline = row.arms.default?.wallMs
    for (const arm of arms) {
      const value = row.arms[arm]?.wallMs
      if (arm === 'default' || baseline === undefined || baseline === 0 || value === undefined) continue
      row.arms[arm].deltaVsDefaultPct = Number((((value - baseline) / baseline) * 100).toFixed(1))
    }
    pairedRounds.push(row)
  }
}

const paired = tasks.map((task) => {
  const rounds = pairedRounds.filter((row) => row.task === task.id)
  if (rounds.length === 0) return undefined
  const row = { task: task.id, validRounds: rounds.length, arms: {} }
  for (const arm of arms) {
    row.arms[arm] = {
      medianWallMs: pct(rounds.map((item) => item.arms[arm].wallMs), 50),
      meanSteps: mean(rounds.map((item) => item.arms[arm].steps)),
      meanToolCalls: mean(rounds.map((item) => item.arms[arm].toolCalls)),
      meanInputTokens: mean(rounds.map((item) => item.arms[arm].inputTokens)),
    }
  }
  const baseline = row.arms.default?.medianWallMs
  for (const arm of arms) {
    const value = row.arms[arm]?.medianWallMs
    if (arm === 'default' || baseline === undefined || baseline === 0 || value === undefined) continue
    row.arms[arm].deltaVsDefaultPct = Number((((value - baseline) / baseline) * 100).toFixed(1))
  }
  return row
}).filter(Boolean)

const report = {
  schemaVersion: 3,
  generatedAt: new Date().toISOString(),
  profile,
  catalog: catalogFile,
  runtime: { harness: HARNESS, cli: CLI, dsh: process.env.DSH_VERSION ?? '0.2.0-rc.2' },
  taskCount: tasks.length,
  repeat,
  excludedRuns: excluded,
  validPairRounds: pairedRounds.length,
  summary,
  paired,
  pairedRounds,
  results,
}
const jsonPath = join(root, 'benchmark', `results-${stamp}.json`)
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')

console.log('\n=== summary ===')
for (const arm of arms) {
  const s = summary[arm]
  const baseline = summary.default?.medianWallMs
  const delta = arm === 'default' || baseline === null || baseline === undefined || baseline === 0
    ? null
    : Number((((s.medianWallMs - baseline) / baseline) * 100).toFixed(1))
  console.log(`${arm.padEnd(7)}: n=${s.runs} pass=${s.passed} median=${s.medianWallMs}ms mean=${s.meanWallMs}ms p90=${s.p90WallMs}ms steps=${s.meanSteps} tools=${s.meanToolCalls} inTok=${s.meanInputTokens} outTok=${s.meanOutputTokens} delta=${delta === null ? 'baseline' : `${delta}%`}`)
}
console.log(`results: ${jsonPath}`)

if (outFile) {
  const lines = []
  lines.push('# DSH OVERDRIVE three-arm benchmark', '')
  lines.push(`Generated ${report.generatedAt} on DSH ${report.runtime.dsh}, catalog \`${catalogFile}\`, ${tasks.length} tasks × ${repeat} repeat(s), Latin-square interleaved arms.`)
  lines.push('Latency and token aggregates include machine-validated runs only. Task deltas include only rounds where every requested arm passed.')
  lines.push('')
  lines.push('| arm | runs | passed | median | mean | p90 | first token p50 | steps | tools | max calls/step | runs with parallel step | input tok | output tok | reasoning tok | cache read tok |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const arm of arms) {
    const s = summary[arm]
    lines.push(`| ${arm} | ${s.runs} | ${s.passed}/${s.runs} | ${s.medianWallMs} ms | ${s.meanWallMs} ms | ${s.p90WallMs} ms | ${s.medianFirstTokenMs} ms | ${s.meanSteps} | ${s.meanToolCalls} | ${s.meanMaxCallsPerStep} | ${s.parallelToolRuns}/${s.runs} | ${s.meanInputTokens} | ${s.meanOutputTokens} | ${s.meanReasoningTokens} | ${s.meanCacheReadTokens} |`)
  }
  lines.push('')
  lines.push('| task | valid paired rounds | default | fast | fast Δ | max | max Δ |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const row of paired) {
    const d = row.arms.default
    const f = row.arms.fast
    const m = row.arms.max
    const fastDelta = f?.deltaVsDefaultPct === undefined ? 'n/a' : `${f.deltaVsDefaultPct}%`
    const maxDelta = m?.deltaVsDefaultPct === undefined ? 'n/a' : `${m.deltaVsDefaultPct}%`
    lines.push(`| ${row.task} | ${row.validRounds} | ${d?.medianWallMs ?? 'n/a'} ms | ${f?.medianWallMs ?? 'n/a'} ms | ${fastDelta} | ${m?.medianWallMs ?? 'n/a'} ms | ${maxDelta} |`)
  }
  writeFileSync(join(root, outFile), `${lines.join('\n')}\n`, 'utf8')
  console.log(`report: ${outFile}`)
}

if (existsSync(jsonPath) && Object.values(summary).every((value) => value.passed === 0)) process.exitCode = 1
