#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ICruiseResult } from 'dependency-cruiser'
import { dependencyCruiserConfig } from './architecture.ts'
import { runArchitectureCruise } from './architecture-cruise.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const VIEW_DATA_RULE = 'hub-web-views-do-not-fetch-data-or-read-hub-mode'
const VIEW_DATA_BASELINE = new Set<string>(
  JSON.parse(
    readFileSync(
      join(
        ROOT,
        'scripts/quality/hub-web-views-do-not-fetch-data-or-read-hub-mode-known-violations.json',
      ),
      'utf8',
    ),
  ) as string[],
)
const target = process.argv[2]
const original = process.argv[3] ?? target

if (!target || !original) {
  console.error('usage: bun scripts/check-architecture-file.ts <candidate> [original]')
  process.exit(2)
}

const config = dependencyCruiserConfig()
config.forbidden = config.forbidden.filter(
  ({ name }) => name === VIEW_DATA_RULE || name.startsWith('hub-ui-'),
)
const cruise = await runArchitectureCruise({
  entries: [target],
  extraArgs: ['--max-depth', '1', '--output-type', 'json'],
  stdout: 'pipe',
  config,
})
const result = JSON.parse(cruise.stdout) as ICruiseResult
const rulesByName = new Map(config.forbidden.map((rule) => [rule.name, rule]))

function appliesToOriginalPath(ruleName: string) {
  const from = rulesByName.get(ruleName)?.from
  if (!from || !new RegExp(from.path).test(original)) return false
  return !from.pathNot?.some((pattern) => new RegExp(pattern).test(original))
}

const findings = result.summary.violations.filter(({ from, rule }) => {
  if (rule.severity !== 'error') return false
  if (from === target && !appliesToOriginalPath(rule.name)) return false
  if (rule.name === VIEW_DATA_RULE) return from !== target || !VIEW_DATA_BASELINE.has(original)
  return rule.name.startsWith('hub-ui-')
})

console.log(
  JSON.stringify(
    findings.length
      ? {
          status: 'refused',
          findings: findings.map(({ rule, to }) => ({ rule: rule.name, dependency: to })),
        }
      : { status: 'ok' },
  ),
)
