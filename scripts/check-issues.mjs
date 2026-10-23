#!/usr/bin/env node
/**
 * Validate the machine-readable audit and keep its summary honest.
 *
 * The schema is a hand-rolled subset of draft 2020-12 (type / const / enum /
 * required / properties / additionalProperties / items / minItems / minLength /
 * pattern / $ref / format:date-time). An unsupported keyword is a hard error:
 * a validator that silently ignores what it does not understand is worse than
 * none.
 *
 * Besides schema validity this checks the facts a JSON file cannot enforce on
 * its own:
 *   - issue ids are unique and match TURBO-NNN;
 *   - counts.* agree with the issues actually present;
 *   - suggestedOrder only names known issues and leaves none open out of order;
 *   - every relatedFiles entry exists in the working tree (warning, not error);
 *   - no open issue at or above --fail-on severity (default: critical).
 *
 * Usage:
 *   node scripts/check-issues.mjs                     validate
 *   node scripts/check-issues.mjs --markdown <path>   also write a Markdown view
 *   node scripts/check-issues.mjs --fail-on high      fail on open high+ issues
 *   node scripts/check-issues.mjs --quiet             only print on failure
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const quiet = args.includes('--quiet')
const failOn = flag('--fail-on', 'critical')
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low']

const auditPath = join(root, 'audit', 'issues.json')
const schemaPath = join(root, 'audit', 'issues.schema.json')
const document = JSON.parse(readFileSync(auditPath, 'utf8'))
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))

const errors = []
const warnings = []

/** Resolve a local `#/$defs/x` reference. */
function deref(node) {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const match = /^#\/\$defs\/([^/]+)$/.exec(node.$ref)
    if (!match) throw new Error(`unsupported $ref: ${node.$ref}`)
    const target = schema.$defs?.[match[1]]
    if (!target) throw new Error(`$ref target not found: ${node.$ref}`)
    return target
  }
  return node
}

const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description', '$defs',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'minLength', 'minimum', 'maximum', 'pattern', 'format', '$ref',
])

function validate(value, node, path) {
  node = deref(node)
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) throw new Error(`schema keyword "${key}" at ${path} is not implemented by this validator`)
  }

  if (node.const !== undefined && value !== node.const) {
    errors.push(`${path}: expected const ${JSON.stringify(node.const)}, got ${JSON.stringify(value)}`)
  }
  if (node.enum !== undefined && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(node.enum)}`)
  }

  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type]
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const normalized = actual === 'number' && Number.isInteger(value) ? 'integer' : actual
    if (!types.includes(actual) && !types.includes(normalized)) {
      errors.push(`${path}: expected ${types.join('|')}, got ${actual}`)
      return
    }
  }

  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${path}: ${value} is below minimum ${node.minimum}`)
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${path}: ${value} is above maximum ${node.maximum}`)
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push(`${path}: shorter than ${node.minLength} characters`)
    }
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: does not match /${node.pattern}/`)
    }
    if (node.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${path}: not a parseable date-time`)
    }
    if (node.format !== undefined && node.format !== 'date-time') {
      throw new Error(`format "${node.format}" at ${path} is not implemented by this validator`)
    }
  }

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push(`${path}: needs at least ${node.minItems} item(s)`)
    }
    if (node.items !== undefined) {
      value.forEach((item, index) => validate(item, node.items, `${path}[${index}]`))
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required "${key}"`)
    }
    const properties = node.properties ?? {}
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] !== undefined) {
        validate(child, properties[key], `${path}.${key}`)
      } else if (node.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`)
      }
    }
  }
}

// ── 1. schema ────────────────────────────────────────────────────────────────
validate(document, schema, '$')

// ── 2. cross-field facts ────────────────────────────────────────────────────
const issues = document.issues ?? []
const ids = new Set()
for (const issue of issues) {
  if (ids.has(issue.id)) errors.push(`duplicate issue id ${issue.id}`)
  ids.add(issue.id)
  if (!/^TURBO-\d{3}$/.test(issue.id ?? '')) errors.push(`bad issue id ${issue.id}`)
}

const statusCount = { open: 0, fixed: 0, documented: 0, accepted: 0, wontfix: 0 }
const severityCount = { critical: 0, high: 0, medium: 0, low: 0 }
for (const issue of issues) {
  statusCount[issue.status] += 1
  severityCount[issue.severity] += 1
}

const expectedCounts = {
  total: issues.length,
  open: statusCount.open,
  fixed: statusCount.fixed,
  documented: statusCount.documented,
  accepted: statusCount.accepted,
  bySeverity: severityCount,
}
for (const [key, expected] of Object.entries(expectedCounts)) {
  if (key === 'bySeverity') {
    for (const [severity, value] of Object.entries(expected)) {
      const actual = document.counts?.bySeverity?.[severity]
      if (actual !== value) errors.push(`counts.bySeverity.${severity}=${actual}, but ${value} issue(s) exist`)
    }
  } else if (document.counts?.[key] !== expected) {
    errors.push(`counts.${key}=${document.counts?.[key]}, but ${expected} issue(s) exist`)
  }
}

for (const id of document.suggestedOrder ?? []) {
  if (!ids.has(id)) errors.push(`suggestedOrder names unknown issue ${id}`)
}
const orderedOpen = (document.suggestedOrder ?? []).filter((id) => {
  const issue = issues.find((entry) => entry.id === id)
  return issue !== undefined && issue.status === 'open'
})
const openIds = issues.filter((issue) => issue.status === 'open').map((issue) => issue.id)
const unordered = openIds.filter((id) => !orderedOpen.includes(id))
if (unordered.length > 0) warnings.push(`open issues absent from suggestedOrder: ${unordered.join(', ')}`)

for (const issue of issues) {
  for (const file of issue.relatedFiles ?? []) {
    if (!existsSync(join(root, file))) warnings.push(`${issue.id}: related file does not exist: ${file}`)
  }
}

const failRank = SEVERITY_ORDER.indexOf(failOn)
if (failRank === -1) throw new Error(`--fail-on must be one of ${SEVERITY_ORDER.join('|')}`)
const blocking = issues.filter((issue) => issue.status === 'open' && SEVERITY_ORDER.indexOf(issue.severity) <= failRank)

// ── 3. report ───────────────────────────────────────────────────────────────
if (!quiet || errors.length > 0) {
  console.log(`audit: ${document.subject.name}@${document.subject.version} (git ${document.subject.gitHead ?? '?'})`)
  console.log(`gates: ${(document.gates ?? []).map((gate) => `${gate.id}=${gate.result}`).join(' ')}`)
  console.log(`issues: ${issues.length} total, ${statusCount.open} open ` +
    `(critical ${severityCount.critical}, high ${severityCount.high}, medium ${severityCount.medium}, low ${severityCount.low})`)
  if (blocking.length > 0) {
    for (const issue of blocking) console.log(`  BLOCKING [${issue.severity}] ${issue.id} ${issue.title} — ${issue.recommendation.action}`)
  }
  for (const warning of warnings) console.log(`  warning: ${warning}`)
}

if (errors.length > 0) {
  for (const error of errors) console.error(`  error: ${error}`)
  console.error(`audit invalid: ${errors.length} error(s)`)
  process.exit(1)
}

const markdownPath = flag('--markdown', undefined)
if (markdownPath) {
  const lines = []
  lines.push(`# ${document.subject.name} audit — ${document.subject.version}`, '')
  lines.push(`Generated ${document.generatedAt} · git \`${document.subject.gitHead ?? '?'}\` · DSH ${document.environment.dshVersion} (${document.environment.dshSurface})`)
  lines.push('')
  lines.push('> Generated from `audit/issues.json` by `node scripts/check-issues.mjs --markdown audit/ISSUES.md`. Do not edit by hand.', '')
  lines.push('## Gates', '', '| gate | result | command |', '|---|---|---|')
  for (const gate of document.gates ?? []) {
    lines.push(`| ${gate.id} | ${gate.result} | \`${gate.command}\` |`)
  }
  lines.push('', '## Issues', '', '| id | severity | status | title |', '|---|---|---|---|')
  for (const issue of issues) {
    lines.push(`| ${issue.id} | ${issue.severity} | ${issue.status} | ${issue.title} |`)
  }
  lines.push('')
  for (const issue of issues) {
    lines.push(`### ${issue.id} — ${issue.title}`, '')
    lines.push(`- severity: **${issue.severity}** · status: ${issue.status} · category: ${issue.category}`)
    lines.push(`- recommendation: ${issue.recommendation.action} (effort ${issue.recommendation.effort}, risk ${issue.recommendation.risk})`)
    if (issue.workaround) lines.push(`- workaround: ${issue.workaround}`)
    lines.push('', issue.summary, '')
    lines.push('Evidence:')
    for (const item of issue.evidence) lines.push(`- ${item}`)
    if (issue.relatedFiles?.length) lines.push('', `Files: ${issue.relatedFiles.map((file) => `\`${file}\``).join(', ')}`)
    lines.push('')
  }
  writeFileSync(join(root, markdownPath), `${lines.join('\n').trimEnd()}\n`, 'utf8')
  if (!quiet) console.log(`markdown: ${markdownPath}`)
}

if (blocking.length > 0) {
  console.error(`audit gate failed: ${blocking.length} open issue(s) at or above ${failOn}`)
  process.exit(2)
}
