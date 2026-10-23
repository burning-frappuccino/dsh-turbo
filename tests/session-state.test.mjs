/**
 * Session state: the Host is the only authority, and the revision guard is what
 * makes a double click or two tabs converge instead of racing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurboSessionStore, isSessionId, parseMode } from '../lib/index.js'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'

test('a new Session reads as Turbo OFF with revision 0', () => {
  const store = new TurboSessionStore()
  assert.deepEqual(store.get(SESSION), { sessionId: SESSION, mode: 'default', revision: 0, updatedAt: 0 })
})

test('an accepted write bumps the revision and keeps one record per Session', () => {
  const store = new TurboSessionStore({ now: () => 1000 })
  const first = store.set(SESSION, 'turbo')
  assert.equal(first.changed, true)
  assert.equal(first.state.mode, 'turbo')
  assert.equal(first.state.revision, 1)
  assert.equal(first.state.updatedAt, 1000)

  const second = store.set(SESSION, 'default', 1)
  assert.equal(second.changed, true)
  assert.equal(second.state.mode, 'default')
  assert.equal(second.state.revision, 2)
  assert.equal(store.size, 1)
})

test('a stale expectedRevision is rejected and returns the authoritative record', () => {
  const store = new TurboSessionStore()
  store.set(SESSION, 'turbo') // revision 1
  const stale = store.set(SESSION, 'default', 0)
  assert.equal(stale.changed, false)
  assert.equal(stale.conflict, true)
  assert.equal(stale.state.mode, 'turbo')
  assert.equal(stale.state.revision, 1)
})

test('re-selecting the current mode is idempotent and does not bump the revision', () => {
  const store = new TurboSessionStore()
  const on = store.set(SESSION, 'turbo')
  const again = store.set(SESSION, 'turbo', on.state.revision)
  assert.equal(again.changed, false)
  assert.equal(again.conflict, undefined)
  assert.equal(again.state.revision, on.state.revision)
})

test('mode is isolated per Session', () => {
  const store = new TurboSessionStore()
  const other = 'session-99999999-8888-7777-6666-555555555555'
  store.set(SESSION, 'turbo')
  assert.equal(store.get(SESSION).mode, 'turbo')
  assert.equal(store.get(other).mode, 'default')
})

test('subscribers see accepted writes only', () => {
  const store = new TurboSessionStore()
  const seen = []
  const off = store.subscribe((state, cause) => seen.push([state.mode, cause]))
  store.set(SESSION, 'turbo')
  store.set(SESSION, 'turbo') // no-op
  off()
  store.set(SESSION, 'default')
  assert.deepEqual(seen, [['turbo', 'set']])
})

test('state survives a reload and a corrupt document starts empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-turbo-state-'))
  try {
    const path = join(dir, 'state.json')
    const store = new TurboSessionStore({ path })
    store.set(SESSION, 'turbo')
    store.flush()

    const reopened = new TurboSessionStore({ path })
    assert.equal(reopened.get(SESSION).mode, 'turbo')
    assert.equal(reopened.get(SESSION).revision, 1)

    // A truncated document must not take the profile down.
    const fs = readFileSync(path, 'utf8')
    assert.match(fs, /"version": 1/)
    rmSync(path)
    writeFileSync(path, '{ not json', 'utf8')
    const recovered = new TurboSessionStore({ path })
    assert.equal(recovered.get(SESSION).mode, 'default')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prune drops expired records and keeps recent ones', () => {
  let now = 1_000_000
  const store = new TurboSessionStore({ ttlMs: 1000, now: () => now })
  store.set(SESSION, 'turbo')
  now += 500
  const fresh = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  store.set(fresh, 'turbo')
  now += 700 // SESSION is now 1200ms old, fresh is 700ms old
  assert.equal(store.prune(), 1)
  assert.equal(store.get(SESSION).mode, 'default')
  assert.equal(store.get(fresh).mode, 'turbo')
})

test('wire validation accepts only real session tokens and modes', () => {
  assert.equal(isSessionId('session-abc'), true)
  assert.equal(isSessionId('codex-01a03daa-e4c0-73f0'), true)
  assert.equal(isSessionId(''), false)
  assert.equal(isSessionId('../escape'), false)
  assert.equal(isSessionId('a b'), false)
  assert.equal(isSessionId(42), false)
  assert.equal(parseMode('turbo'), 'turbo')
  assert.equal(parseMode('default'), 'default')
  assert.equal(parseMode('TURBO'), undefined)
  assert.equal(parseMode(true), undefined)
})
