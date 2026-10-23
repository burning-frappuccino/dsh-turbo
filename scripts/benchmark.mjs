#!/usr/bin/env node
/**
 * Turbo ON/OFF benchmark harness (Phase 3).
 *
 * Design (see compatibility-report.md §7 for why this surface):
 * - one headless DSH run per measurement: `dsh --profile <bench> --json "<task>"`
 *   on the SAME 0.2.0 runtime the GUI uses;
 * - a fresh workspace per run, seeded from the task's `seed` so both arms start
 *   from identical bytes;
 * - the only difference between arms is `dsh-turbo.config.defaultMode`, applied
 *   as a `--patch` overlay — same profile, same model, same tools, same safety;
 * - arms are interleaved per task and the order flips on odd task indexes, so
 *   cache warm-up and time-of-day drift do not favour one arm.
 *
 * Measurements come from the runner's own event stream (not from reply length):
 * wall-clock, first-token latency, model steps, tool calls, tokens, whether a
 * verification command ran, and a machine-checked pass/fail.
 *
 * Usage:
 *   node scripts/benchmark.mjs --profile turbo-bench --limit 3
 *   node scripts/benchmark.mjs --profile turbo-bench --tasks sum-js,fix-offbyone
 *   node scripts/benchmark.mjs --profile turbo-bench --repeat 2 --out PERFORMANCE.md
 */

import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const HARNESS = process.env.DSH_EXE ??
  'C:\\Users\\19128\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe'
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
const limit = Number(arg('--limit', '0'))
const only = (arg('--tasks', '') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
const repeat = Number(arg('--repeat', '1'))
const outFile = arg('--out', '')
const keepWorkspaces = args.includes('--keep')

const catalog = JSON.parse(readFileSync(join(root, 'benchmark', 'tasks.json'), 'utf8'))
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

/** Write a `--patch` overlay that pins the Turbo default mode for one arm. */
function patchFor(mode, index) {
  const file = join(runRoot, `patch-${mode}-${index}.yml`)
  writeFileSync(file, [
    '- id: dsh-turbo',
    '  name: dsh-turbo',
    '  config:',
    '    evidenceLog: true',
    `    storageDir: dsh-turbo-bench-${mode}`,
    `    defaultMode: ${mode}`,
    '',
  ].join('\n'), 'utf8')
  return file
}

/** Run one headless task and fold its event stream into measurements. */
function runOne(task, mode, index, attempt = 1) {
  const workspace = join(runRoot, `${stamp}-${task.id}-${mode}-${index}-a${attempt}`)
  mkdirSync(workspace, { recursive: true })
  for (const [name, content] of Object.entries(task.seed ?? {})) {
    writeFileSync(join(workspace, name), content, 'utf8')
  }
  const patch = patchFor(mode, index)
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
        mode,
        index,
        wallMs,
        steps,
        toolCalls: toolCalls.length,
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
async function runWithRetry(task, mode, index) {
  const attempts = 3
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runOne(task, mode, index, attempt)
    if (!result.transportFailed) return result
    if (attempt < attempts) {
      console.log(`transport failure, retrying (${attempt}/${attempts - 1})…`)
      await delay(5000)
      continue
    }
    return { ...result, excluded: true }
  }
  return undefined
}

// ── main loop ────────────────────────────────────────────────────────────────
console.log(`dsh-turbo benchmark — profile=${profile} tasks=${tasks.length} repeat=${repeat}`)
console.log(`runtime: ${HARNESS}`)

for (let round = 1; round <= repeat; round += 1) {
  for (const [index, task] of tasks.entries()) {
    // Interleave: alternate which arm goes first so neither always warms the cache.
    const order = (index + round) % 2 === 0 ? ['turbo', 'default'] : ['default', 'turbo']
    for (const mode of order) {
      process.stdout.write(`[${round}.${index + 1}] ${task.id.padEnd(16)} ${mode.padEnd(8)} `)
      const result = await runWithRetry(task, mode, index)
      results.push(result)
      console.log(result.excluded === true
        ? `EXCLUDED (provider transport failure after retries)`
        : `wall=${result.wallMs}ms steps=${result.steps} tools=${result.toolCalls} pass=${result.passed ? 'y' : 'n'}`)
    }
  }
}

// ── summary ──────────────────────────────────────────────────────────────────
const arms = ['turbo', 'default']
const usable = results.filter((row) => row.excluded !== true)
const excluded = results.length - usable.length
const summary = {}
for (const arm of arms) {
  const rows = usable.filter((row) => row.mode === arm)
  const wall = rows.map((row) => row.wallMs)
  summary[arm] = {
    runs: rows.length,
    passed: rows.filter((row) => row.passed).length,
    successRate: rows.length === 0 ? null : Number((rows.filter((row) => row.passed).length / rows.length).toFixed(3)),
    medianWallMs: pct(wall, 50),
    meanWallMs: mean(wall),
    p90WallMs: pct(wall, 90),
    meanSteps: mean(rows.map((row) => row.steps)),
    meanToolCalls: mean(rows.map((row) => row.toolCalls)),
    meanInputTokens: mean(rows.map((row) => row.inputTokens)),
    meanOutputTokens: mean(rows.map((row) => row.outputTokens)),
    verificationRuns: rows.filter((row) => row.verificationObserved).length,
    meanFinalChars: mean(rows.map((row) => row.finalChars)),
  }
}

const paired = []
for (const task of tasks) {
  const on = usable.filter((row) => row.task === task.id && row.mode === 'turbo').map((row) => row.wallMs)
  const off = usable.filter((row) => row.task === task.id && row.mode === 'default').map((row) => row.wallMs)
  if (on.length === 0 || off.length === 0) continue
  const medianOn = pct(on, 50)
  const medianOff = pct(off, 50)
  paired.push({
    task: task.id,
    turboMs: medianOn,
    defaultMs: medianOff,
    deltaPct: medianOff === 0 ? null : Number((((medianOn - medianOff) / medianOff) * 100).toFixed(1)),
    turboPassed: usable.filter((row) => row.task === task.id && row.mode === 'turbo').every((row) => row.passed),
    defaultPassed: usable.filter((row) => row.task === task.id && row.mode === 'default').every((row) => row.passed),
    turboSteps: mean(usable.filter((row) => row.task === task.id && row.mode === 'turbo').map((row) => row.steps)),
    defaultSteps: mean(usable.filter((row) => row.task === task.id && row.mode === 'default').map((row) => row.steps)),
  })
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  profile,
  runtime: { harness: HARNESS, cli: CLI, dsh: process.env.DSH_VERSION ?? '0.2.0-rc.2' },
  taskCount: tasks.length,
  repeat,
  excludedRuns: excluded,
  summary,
  paired,
  results,
}
const jsonPath = join(root, 'benchmark', `results-${stamp}.json`)
writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')

const deltaMedian = summary.default.medianWallMs === 0 || summary.default.medianWallMs === null
  ? null
  : Number((((summary.turbo.medianWallMs - summary.default.medianWallMs) / summary.default.medianWallMs) * 100).toFixed(1))

console.log('\n=== summary ===')
console.log(`turbo  : n=${summary.turbo.runs} pass=${summary.turbo.passed} median=${summary.turbo.medianWallMs}ms mean=${summary.turbo.meanWallMs}ms p90=${summary.turbo.p90WallMs}ms steps=${summary.turbo.meanSteps} tools=${summary.turbo.meanToolCalls} inTok=${summary.turbo.meanInputTokens}`)
console.log(`default: n=${summary.default.runs} pass=${summary.default.passed} median=${summary.default.medianWallMs}ms mean=${summary.default.meanWallMs}ms p90=${summary.default.p90WallMs}ms steps=${summary.default.meanSteps} tools=${summary.default.meanToolCalls} inTok=${summary.default.meanInputTokens}`)
console.log(`paired median delta (turbo vs default): ${deltaMedian === null ? 'n/a' : `${deltaMedian}%`}`)
console.log(`results: ${jsonPath}`)

if (outFile) {
  const lines = []
  lines.push('# Turbo ON/OFF benchmark', '')
  lines.push(`Generated ${report.generatedAt} on DSH ${report.runtime.dsh}, ${tasks.length} tasks × ${repeat} repeat(s), interleaved arms.`)
  lines.push('')
  lines.push('| arm | runs | passed | median | mean | p90 | mean steps | mean tool calls | mean input tokens |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const arm of ['turbo', 'default']) {
    const s = summary[arm]
    lines.push(`| ${arm} | ${s.runs} | ${s.passed}/${s.runs} | ${s.medianWallMs} ms | ${s.meanWallMs} ms | ${s.p90WallMs} ms | ${s.meanSteps} | ${s.meanToolCalls} | ${s.meanInputTokens} |`)
  }
  lines.push('')
  lines.push('| task | turbo | default | delta | both passed |')
  lines.push('|---|---|---|---|---|')
  for (const row of paired) {
    lines.push(`| ${row.task} | ${row.turboMs} ms | ${row.defaultMs} ms | ${row.deltaPct === null ? 'n/a' : `${row.deltaPct}%`} | ${row.turboPassed && row.defaultPassed ? 'yes' : 'no'} |`)
  }
  writeFileSync(join(root, outFile), `${lines.join('\n')}\n`, 'utf8')
  console.log(`report: ${outFile}`)
}

if (existsSync(jsonPath) && summary.turbo.passed + summary.default.passed === 0) process.exitCode = 1
