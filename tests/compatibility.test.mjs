/**
 * Compatibility gate.
 *
 * Every assertion here encodes a fact verified against DSH 0.2.0-rc.2 (see
 * compatibility-report.md). A DSH upgrade that changes a loader rule, a slot
 * name, or a baseline module will fail this suite *before* it fails in a live
 * profile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('the manifest declares both halves and a bundle patch', () => {
  assert.equal(pkg.name, 'dsh-turbo')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js', 'the client bundle is resolved by exports["./client"]')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.external ?? [], [], 'only baseline modules are requested, so no externals are declared')
  assert.match(pkg.dsh.engines.dsh, /^>=0\.2\.0-rc\.1$/, 'the tested runtime floor is declared')
  assert.equal(pkg.dsh.compatibility.dshReleases['0.2.0-rc.2'], 'tested')
  for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(join(root, file)), `${file} exists (files[] must ship it)`)
    if (file !== 'README.md' && file !== 'LICENSE') assert.ok(pkg.files.includes(file), `${file} is listed in files[]`)
  }
})

test('the bundle patch inserts exactly one row with known config keys', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /- insert:/)
  assert.match(patch, /- id: dsh-turbo\n {6}name: dsh-turbo/)
  const keys = [...patch.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
  assert.deepEqual(keys.sort(), ['defaultGear', 'defaultMode', 'evidenceLog', 'maxReasoningEffort', 'reasoningEffort', 'sectionOrder', 'storageDir'])
})

test('the Host artifact exports a Cordis functional plugin with no DSH imports', () => {
  const host = read('lib/index.js')
  assert.match(host, /^\/\/ dsh-turbo .* Host half/m)
  assert.match(host, /export \{\s*DEFAULT_POLICY,/)
  assert.match(host, /\bapply\b/)
  assert.match(host, /\binject\b/)
  const imports = [...host.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1])
  assert.ok(imports.length > 0, 'node builtins are imported')
  for (const specifier of imports) {
    assert.match(specifier, /^node:/, `host imports only node builtins, saw ${specifier}`)
  }
  assert.match(host, /export const inject = \["webServer"\]|webServer/)
})

test('the client artifact is a ModuleLoader factory over baseline modules only', () => {
  const client = read('lib/client.js')
  assert.ok(client.startsWith('// dsh-turbo'), 'generated banner is present')
  assert.match(client, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(client, /id: "dsh-turbo"/)
  assert.match(client, /factory: \(require\) => \{/)
  assert.match(client, /return module\.exports;/)

  const requires = [...client.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
  const unique = [...new Set(requires)].sort()
  assert.deepEqual(unique, ['react', 'react/jsx-runtime'], 'only the platform baseline is requested')
  for (const specifier of unique) {
    assert.ok(!specifier.startsWith('@deepseek-ai/'), 'no DSH package is required at runtime')
  }

  // The toggle must not reach into the host page: no DOM query/selector hacks.
  assert.doesNotMatch(client, /querySelector\(['"]\.(?!dshTurbo)/, 'no host-DOM poking')
  assert.doesNotMatch(client, /innerHTML\s*=/)
  assert.doesNotMatch(client, /document\.body\.(appendChild|insertBefore)/)
})

test('no execution path filters tools by keyword', () => {
  // The brief forbids "fast mode" implemented as string filtering of test/build.
  const sources = ['lib/index.js', 'lib/client.js']
    .map(read)
    .join('\n')
  assert.doesNotMatch(sources, /\.includes\(\s*['"]test['"]\s*\)/)
  assert.doesNotMatch(sources, /\.includes\(\s*['"]build['"]\s*\)/)
  assert.doesNotMatch(sources, /blockedTools|denylist|denyTools/)
  // Verification detection exists, but it only records a metric.
  assert.match(read('src/host/metrics.ts'), /VERIFICATION_COMMAND/)
})

test('the prompt policy states delivery, verification disclosure and safeguards', () => {
  const prompt = read('src/prompts/turbo-policy.ts')
  assert.match(prompt, /TURBO EXECUTION MODE/)
  assert.match(prompt, /wall-clock/i)
  assert.match(prompt, /Keep planning compact/)
  assert.match(prompt, /Verified: none/)
  assert.match(prompt, /cheapest command that would catch a wrong result/)
  assert.match(prompt, /Never describe code as tested when no test ran/i)
  assert.match(prompt, /Mandatory permissions, approvals, sandbox rules, and checks are never skipped/i)
  assert.match(prompt, /Tool failures that block completion still get the minimal repair/i)
  assert.match(prompt, /not an optional stage/)
  assert.match(prompt, /MAX GEAR/)
  assert.match(prompt, /never duplicate a mutating or non-idempotent action/i)
})

test('the bridge owns one documented prefix and no catch-all route', () => {
  const plugin = read('src/host/plugin.ts')
  assert.match(plugin, /ROUTE_PREFIX = '\/api\/dsh-turbo'/)
  const routes = [...plugin.matchAll(/path: `\$\{ROUTE_PREFIX\}\/([a-z]+)`/g)].map((match) => match[1])
  assert.deepEqual(routes.sort(), ['health', 'state'])
  assert.doesNotMatch(plugin, /kind: 'prefix'/, 'exact routes only: the bridge must not shadow /api')
})

test('the plugin never mutates upstream DSH sources or global prompts', () => {
  const plugin = read('src/host/runtime-adapter.ts')
  // It registers one named section; it does not replace the persona or the identity.
  assert.doesNotMatch(plugin, /harness:identity/)
  assert.doesNotMatch(plugin, /deployment:persona-prefix/)
  assert.doesNotMatch(plugin, /deployment:persona-suffix/)
  assert.match(plugin, /TURBO_SECTION_NAME/)
  // No permission or sandbox tampering.
  for (const forbidden of ['approval', 'sandbox', 'permission']) {
    assert.doesNotMatch(plugin, new RegExp(`ctx\\.${forbidden}\\b`), `the adapter does not touch ctx.${forbidden}`)
  }
})
