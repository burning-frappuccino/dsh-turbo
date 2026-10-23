/**
 * Build both halves of DSH Turbo.
 *
 * Host half   → lib/index.js   (ESM, node, everything bundled)
 * Client half → lib/client.js  (browser bundle registering a ModuleLoader factory)
 *
 * The client wrapper is not cosmetic: DSH's client module system serves a
 * bundle that must call `window.__ModuleLoader__.load({ id, factory })`, and
 * the factory body is CommonJS so `require('react')` resolves against the
 * platform module table. esbuild's banner/footer keep the wrapper inside one
 * file so the emitted source map still lines up.
 *
 * Usage:
 *   node scripts/build.mjs            write lib/
 *   node scripts/build.mjs --check    verify lib/ matches src/ (CI gate)
 */

import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const versionSource = await readFile(join(root, 'src/version.ts'), 'utf8')
if (!versionSource.includes(`PLUGIN_VERSION = '${pkg.version}'`)) {
  console.error(`src/version.ts PLUGIN_VERSION must equal package.json version (${pkg.version})`)
  process.exit(1)
}

const common = {
  bundle: true,
  logLevel: 'warning',
  minify: false,
  legalComments: 'none',
  sourcemap: 'linked',
  target: ['es2022'],
  metafile: false,
}

const hostOptions = {
  ...common,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  format: 'esm',
  platform: 'node',
  banner: {
    js: `// dsh-turbo ${pkg.version} — Host half (generated from src/ by scripts/build.mjs)`,
  },
}

const clientOptions = {
  ...common,
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(root, 'lib/client.js'),
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  // The browser module table seeds React; requiring it keeps one React
  // instance and one JSX runtime for every plugin on the page.
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: [
      `// dsh-turbo ${pkg.version} — Web client half (generated from src/ by scripts/build.mjs)`,
      '// Registers a factory with the DSH client module system; nothing renders until',
      '// the slot this plugin claims is first materialized.',
      'window.__ModuleLoader__.load({',
      `  id: ${JSON.stringify(pkg.name)},`,
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  },', '});'].join('\n'),
  },
}

/** Build without writing and report any file whose content would change. */
async function verify(options) {
  const result = await build({ ...options, write: false })
  const stale = []
  for (const output of result.outputFiles ?? []) {
    let existing
    try {
      existing = await readFile(output.path, 'utf8')
    } catch {
      stale.push(`${output.path} (missing)`)
      continue
    }
    if (existing !== output.text) stale.push(output.path)
  }
  return stale
}

if (check) {
  const stale = [...await verify(hostOptions), ...await verify(clientOptions)]
  if (stale.length > 0) {
    console.error(`build output is stale; run \`pnpm run build\`:\n  ${stale.join('\n  ')}`)
    process.exit(1)
  }
  console.log('build output matches src/')
  process.exit(0)
}

await mkdir(join(root, 'lib'), { recursive: true })
await build(hostOptions)
await build(clientOptions)
console.log(`built lib/index.js and lib/client.js for ${pkg.name}@${pkg.version}`)
