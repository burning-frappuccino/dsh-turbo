/**
 * Runtime policy: the Host half must apply a *real* difference at a real
 * lifecycle boundary, and it must report honestly what it cannot control.
 *
 * These tests drive the shipped Host bundle through a fake Cordis context, so
 * they assert the observed hook shapes from compatibility-report.md rather than
 * a hopeful reading of them.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, resolveConfig, TURBO_SECTION_NAME, TURBO_POLICY_MARKER, looksLikeVerification } from '../lib/index.js'
import { createFakeHost, fakeRequest, fakeResponse } from './helpers/fake-host.mjs'

const SESSION = 'session-policy-test'

let home

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-turbo-home-'))
  process.env.DSH_HOME = home
})

process.on('exit', () => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

/** Boot the Host half over a fake ctx and return the handles tests need. */
function boot(config = {}) {
  const host = createFakeHost()
  apply(host.ctx, config)
  return host
}

function findRoute(host, path) {
  const route = host.routes.find((entry) => entry.path === path)
  assert.ok(route, `route ${path} is registered`)
  return route
}

async function readState(host, sessionId = SESSION) {
  const route = findRoute(host, '/api/dsh-turbo/state')
  const res = fakeResponse()
  await route.handler(fakeRequest({ method: 'GET', url: `/api/dsh-turbo/state?sessionId=${sessionId}` }), res)
  return { status: res.state.status, body: res.json() }
}

async function writeState(host, body) {
  const route = findRoute(host, '/api/dsh-turbo/state')
  const res = fakeResponse()
  await route.handler(fakeRequest({
    method: 'POST',
    url: '/api/dsh-turbo/state',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), res)
  return { status: res.state.status, body: res.json() }
}

test('the prompt section renders the policy only for Turbo Sessions', () => {
  const host = boot()
  const section = host.sections.find((entry) => entry.name === TURBO_SECTION_NAME)
  assert.ok(section, 'a turbo prompt section is registered')
  assert.equal(typeof section.text, 'function', 'text is resolved per assembly')

  const agent = { id: SESSION, session: { id: SESSION } }
  assert.equal(section.text({ agent }), '', 'default mode contributes no text')

  host.ctx.systemPrompt.section // touch: the service is the same instance
  const store = { agent }
  void store
  // Flip the Session through the public bridge, then re-resolve.
  return writeState(host, { sessionId: SESSION, mode: 'turbo' }).then(() => {
    const text = section.text({ agent })
    assert.match(text, new RegExp(TURBO_POLICY_MARKER))
    assert.match(text, /verified/i)
    assert.match(text, /permissions/i)

    return writeState(host, { sessionId: SESSION, mode: 'turbo', gear: 'max', expectedRevision: 1 }).then(() => {
      const maxText = section.text({ agent })
      assert.match(maxText, /MAX GEAR/)
      assert.match(maxText, /extra token and tool budget/i)
      assert.match(maxText, /same turn instead of serially/i)

      const other = { id: 'session-other', session: { id: 'session-other' } }
      assert.equal(section.text({ agent: other }), '', 'other Sessions are untouched')
      assert.equal(section.text({}), '', 'an assembly without an agent gets no policy')
    })
  })
})

test('the config tolerates unknown keys but rejects invalid known values', () => {
  assert.deepEqual(resolveConfig(undefined), {
    sectionOrder: 700,
    reasoningEffort: 'inherit',
    maxReasoningEffort: 'high',
    evidenceLog: true,
    storageDir: 'dsh-turbo',
    defaultMode: 'default',
    defaultGear: 'fast',
  })
  const warned = []
  assert.equal(resolveConfig({ nope: true }, (keys) => warned.push(...keys)).sectionOrder, 700)
  assert.deepEqual(warned, ['nope'])
  assert.throws(() => resolveConfig({ sectionOrder: 'high' }), /finite number/)
  assert.throws(() => resolveConfig({ reasoningEffort: 'turbo' }), /reasoningEffort/)
  assert.throws(() => resolveConfig({ maxReasoningEffort: 'turbo' }), /maxReasoningEffort/)
  assert.throws(() => resolveConfig({ storageDir: '../escape' }), /storageDir/)
  assert.throws(() => resolveConfig({ defaultMode: 'warp' }), /defaultMode/)
  assert.throws(() => resolveConfig({ defaultGear: 'warp' }), /defaultGear/)
  // A deployment may make Turbo the default for new Sessions.
  assert.equal(resolveConfig({ defaultMode: 'turbo' }).defaultMode, 'turbo')
  assert.equal(resolveConfig({ defaultGear: 'max' }).defaultGear, 'max')
})

test('Turbo alone lowers reasoning effort and preserves the rest of the request', async () => {
  const host = boot({ reasoningEffort: 'minimal' })
  const agent = { id: SESSION, session: { id: SESSION }, ctx: host.ctx }
  host.emit('agent/created', { agent })

  const baseline = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 4096 }
  const request = () => host.dispatchWaterfall(
    'agent/request',
    { turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve(baseline),
  )

  assert.deepEqual(await request(), baseline, 'Turbo OFF must leave the request byte-for-byte unchanged')
  await writeState(host, { sessionId: SESSION, mode: 'turbo', expectedRevision: 0 })
  assert.deepEqual(await request(), { ...baseline, reasoningEffort: 'minimal' })

  // An installed hook is not proof: the capability stays off until a real
  // request header carries the value (another listener can strip it).
  let { body } = await readState(host)
  let effort = body.capabilities.find((entry) => entry.id === 'reasoning-effort')
  assert.equal(effort.state, 'off', 'no Turbo request has been observed yet')
  assert.match(effort.detail, /no Turbo request has been observed/)

  host.emit('session/event', { id: SESSION }, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'minimal' } } },
  })
  ;({ body } = await readState(host))
  effort = body.capabilities.find((entry) => entry.id === 'reasoning-effort')
  assert.equal(effort.state, 'applied', 'the wire really carried the configured effort')
  assert.match(effort.detail, /in request\/header/)

  // The shipped model-selection listener re-applies its own effort; a header
  // that disagrees must demote the capability instead of lying about it.
  host.emit('session/event', { id: SESSION }, {
    type: 'request/header',
    data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } } },
  })
  ;({ body } = await readState(host))
  effort = body.capabilities.find((entry) => entry.id === 'reasoning-effort')
  assert.equal(effort.state, 'off')
  assert.match(effort.detail, /resolved "high"/)

  await writeState(host, { sessionId: SESSION, mode: 'default', expectedRevision: 1 })
  assert.deepEqual(await request(), baseline, 'turning Turbo OFF restores the upstream request')
})

test('a refused reasoning effort retries the turn instead of failing it', async () => {
  // The shipped DeepSeek Messages route accepts only off|low|high|max; an id it
  // refuses must degrade the lever, not kill the turn (that is what a bare
  // override did: `UNSUPPORTED_REASONING_EFFORT` ended the attempt).
  const host = boot({ reasoningEffort: 'minimal' })
  const agent = { id: SESSION, session: { id: SESSION }, ctx: host.ctx }
  host.emit('agent/created', { agent })
  await writeState(host, { sessionId: SESSION, mode: 'turbo', expectedRevision: 0 })

  const baseline = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }
  const request = () => host.dispatchWaterfall(
    'agent/request',
    { turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve(baseline),
  )
  assert.deepEqual(await request(), { ...baseline, reasoningEffort: 'minimal' })

  const action = await host.dispatchWaterfall('agent/request-error', {
    turn: 1,
    step: 1,
    provider: 'deepseek-official',
    failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'provider does not support reasoning effort "minimal"' },
    signal: new AbortController().signal,
  }, () => Promise.resolve(undefined))
  assert.deepEqual(action, { kind: 'retry' }, 'the loop is told to retry without the lever')

  assert.equal(host.count('agent/request'), 0, 'the refused lever is withdrawn for that Agent')
  assert.deepEqual(await host.dispatchWaterfall('agent/request', {
    turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve(baseline)), baseline, 'the retried request is untouched')

  const { body } = await readState(host)
  const effort = body.capabilities.find((entry) => entry.id === 'reasoning-effort')
  assert.equal(effort.state, 'off')
  assert.match(effort.detail, /refused a selected gear effort/)
  assert.match(effort.detail, /kept the turn alive/)
})

test('a different request failure is left to the rest of the chain', async () => {
  const host = boot({ reasoningEffort: 'low' })
  const agent = { id: SESSION, session: { id: SESSION }, ctx: host.ctx }
  host.emit('agent/created', { agent })
  const action = await host.dispatchWaterfall('agent/request-error', {
    turn: 1,
    step: 1,
    failure: { code: 'QUOTA_EXCEEDED', message: 'quota' },
    signal: new AbortController().signal,
  }, () => Promise.resolve(undefined))
  assert.equal(action, undefined, 'unrelated failures are not retried by this plugin')
  assert.equal(host.count('agent/request'), 1, 'the lever stays installed')
})

test('reasoning effort covers existing Agents, de-duplicates events and unloads cleanly', () => {
  const agents = new Map()
  const host = createFakeHost({ agents })
  const config = { reasoningEffort: 'minimal' }
  const agent = { id: SESSION, session: { id: SESSION }, ctx: host.ctx }
  agents.set(SESSION, agent)

  apply(host.ctx, config)
  assert.equal(host.count('agent/request'), 1, 'an Agent that predates the plugin gets the request hook')

  host.emit('agent/created', { agent })
  assert.equal(host.count('agent/request'), 1, 'the later created event does not double-register the hook')

  host.emit('agent/disposed', { agent })
  assert.equal(host.count('agent/request'), 0, 'disposing the Agent releases its request hook')

  host.emit('agent/created', { agent })
  assert.equal(host.count('agent/request'), 1, 'a recreated Agent can attach again')
  host.teardown()
  assert.equal(host.count('agent/request'), 0, 'unloading the plugin releases live Agent hooks immediately')
})

test('GET /state reports default, capabilities and metrics for an unknown Session', async () => {
  const host = boot()
  const { status, body } = await readState(host, 'session-never-seen')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.state.mode, 'default')
  assert.equal(body.state.gear, 'fast')
  assert.equal(body.state.revision, 0)
  assert.equal(body.plugin.name, 'dsh-turbo')
  const ids = body.capabilities.map((entry) => entry.id)
  assert.deepEqual(ids.sort(), [
    'http-bridge',
    'mandatory-checks',
    'optional-stages',
    'pre-step-policy',
    'prompt-policy',
    'reasoning-effort',
    'tool-filtering',
    'turn-metrics',
  ])
  const bridge = body.capabilities.find((entry) => entry.id === 'http-bridge')
  assert.equal(bridge.state, 'applied', 'the fake host has a webServer')
  const promptCap = body.capabilities.find((entry) => entry.id === 'prompt-policy')
  assert.equal(promptCap.state, 'applied')
  const effort = body.capabilities.find((entry) => entry.id === 'reasoning-effort')
  assert.equal(effort.state, 'off')
  assert.match(effort.detail, /Fast "inherit" \/ Max "high"/)
  const optional = body.capabilities.find((entry) => entry.id === 'optional-stages')
  assert.equal(optional.state, 'unavailable', 'turbo never claims it can skip a stage it cannot see')
})

test('POST /state is Host-authoritative and rejects a stale revision', async () => {
  const host = boot()
  const on = await writeState(host, { sessionId: SESSION, mode: 'turbo', expectedRevision: 0 })
  assert.equal(on.status, 200)
  assert.equal(on.body.state.mode, 'turbo')
  assert.equal(on.body.state.gear, 'fast')
  assert.equal(on.body.state.revision, 1)

  const stale = await writeState(host, { sessionId: SESSION, mode: 'default', expectedRevision: 0 })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'conflict')
  assert.equal(stale.body.state.mode, 'turbo', 'the conflict reply carries the truth')
  assert.equal(stale.body.state.revision, 1)

  const off = await writeState(host, { sessionId: SESSION, mode: 'default', expectedRevision: 1 })
  assert.equal(off.status, 200)
  assert.equal(off.body.state.mode, 'default')
  assert.equal(off.body.state.revision, 2)
})

test('Max gear is revision-guarded and selects its own request effort', async () => {
  const host = boot({ reasoningEffort: 'off', maxReasoningEffort: 'low' })
  const agent = { id: SESSION, session: { id: SESSION }, ctx: host.ctx }
  host.emit('agent/created', { agent })
  const selected = await writeState(host, { sessionId: SESSION, mode: 'turbo', gear: 'max', expectedRevision: 0 })
  assert.equal(selected.status, 200)
  assert.equal(selected.body.state.gear, 'max')

  const baseline = { provider: 'deepseek-official', reasoningEffort: 'high' }
  const request = await host.dispatchWaterfall(
    'agent/request',
    { turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve(baseline),
  )
  assert.deepEqual(request, { ...baseline, reasoningEffort: 'low' })

  const stale = await writeState(host, { sessionId: SESSION, mode: 'turbo', gear: 'fast', expectedRevision: 0 })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.state.gear, 'max')
})

test('POST /state rejects malformed requests without touching state', async () => {
  const host = boot()
  const missing = await writeState(host, { mode: 'turbo' })
  assert.equal(missing.status, 400)
  const badMode = await writeState(host, { sessionId: SESSION, mode: 'warp' })
  assert.equal(badMode.status, 400)
  const badRevision = await writeState(host, { sessionId: SESSION, mode: 'turbo', expectedRevision: -1 })
  assert.equal(badRevision.status, 400)
  const badGear = await writeState(host, { sessionId: SESSION, mode: 'turbo', gear: 'warp' })
  assert.equal(badGear.status, 400)
  const stillDefault = await readState(host)
  assert.equal(stillDefault.body.state.mode, 'default')

  const route = findRoute(host, '/api/dsh-turbo/state')
  const wrongType = fakeResponse()
  await route.handler(fakeRequest({
    method: 'POST',
    url: '/api/dsh-turbo/state',
    headers: { 'content-type': 'text/plain' },
    body: '{"sessionId":"x"}',
  }), wrongType)
  assert.equal(wrongType.state.status, 415)
})

test('agent/pre-step stamps the mode, counts steps and writes evidence', async () => {
  const host = boot()
  await writeState(host, { sessionId: SESSION, mode: 'turbo' })
  const agent = { id: SESSION, session: { id: SESSION } }

  // The loop opens the durable turn before proposing a step.
  host.emit('session/event', { id: SESSION }, { type: 'turn/start', data: { turn: 3 } })

  const decision = await host.dispatchWaterfall('agent/pre-step', {
    agent,
    turn: 3,
    step: 1,
    messages: [],
    signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.equal(decision.kind, 'enter')

  await host.dispatchWaterfall('agent/pre-step', {
    agent, turn: 3, step: 2, messages: [], signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  host.emit('session/event', { id: SESSION }, {
    type: 'tool/call',
    data: { turn: 3, step: 2, callId: 'c1', name: 'pwsh', arguments: '{"command":"npm test"}' },
  })
  host.emit('session/event', { id: SESSION }, { type: 'turn/end', data: { turn: 3 } })

  const { body } = await readState(host)
  assert.equal(body.metrics.turns, 1)
  assert.equal(body.metrics.lastSteps, 2)
  assert.equal(body.metrics.lastToolCalls, 1)
  assert.equal(body.metrics.lastVerification, true, 'a test command is observed, not blocked')
  assert.equal(body.metrics.lastMode, 'turbo')
})

test('a rejected pre-step is not counted and does not consume evidence', async () => {
  const host = boot()
  const agent = { id: SESSION, session: { id: SESSION } }
  const decision = await host.dispatchWaterfall('agent/pre-step', {
    agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'reject', messages: [] }))
  assert.equal(decision.kind, 'reject')
  const { body } = await readState(host)
  assert.equal(body.metrics.turns, 0)
})

test('toggling mid-turn applies from the next assembly, not retroactively', async () => {
  const host = boot()
  const section = host.sections.find((entry) => entry.name === TURBO_SECTION_NAME)
  const agent = { id: SESSION, session: { id: SESSION } }
  assert.equal(section.text({ agent }), '')
  await writeState(host, { sessionId: SESSION, mode: 'turbo' })
  assert.match(section.text({ agent }), new RegExp(TURBO_POLICY_MARKER))
  await writeState(host, { sessionId: SESSION, mode: 'default', expectedRevision: 1 })
  assert.equal(section.text({ agent }), '', 'turning Turbo off restores the untouched prompt')
})

test('unload withdraws the routes, the prompt section and the hooks', async () => {
  const host = boot()
  assert.equal(host.routes.length, 2)
  assert.equal(host.sections.length, 1)
  host.teardown()
  assert.equal(host.routes.length, 0)
  assert.equal(host.sections.length, 0)
})

test('verification detection is observation only', () => {
  assert.equal(looksLikeVerification('{"command":"npm test"}'), true)
  assert.equal(looksLikeVerification({ command: 'pnpm run build' }), true)
  assert.equal(looksLikeVerification({ command: 'go test ./...' }), true)
  assert.equal(looksLikeVerification({ command: 'git status' }), false)
  assert.equal(looksLikeVerification({ command: 'echo build later' }), false)
  assert.equal(looksLikeVerification(undefined), false)
})
