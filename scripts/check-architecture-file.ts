#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ICruiseResult } from 'dependency-cruiser'
import { dependencyCruiserConfig, writeTimeArchitectureRules } from './architecture.ts'
import { runArchitectureCruise } from './architecture-cruise.ts'
import {
  hubDataPackageName,
  hubViewsDocsModeLiteralLines,
  hubViewsDocsModeLiteralRuleName,
} from './architecture-hub-data.ts'
import { hubWebSourcePlacementViolation } from './architecture-hub-packages.ts'
import {
  hubUiFolderLayerRuleName,
  isDeclaredHubUiSourceLocation,
} from './architecture-ui-layers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const target = process.argv[2]
const original = process.argv[3] ?? target
const checkoutRoot = process.argv[4] ?? ROOT
const deadlineArgument = process.argv.indexOf('--deadline-ms')
const deadlineMs = Number(process.argv[deadlineArgument + 1])
const pathOnly = process.argv.includes('--path-only')

// This must exceed the command's cleanup margin so this process can remove cruise artifacts.
const ARCHITECTURE_CRUISE_CLEANUP_MARGIN_MS = 1_750
if (!target || !original || deadlineArgument === -1 || !Number.isFinite(deadlineMs)) {
  console.error(
    'usage: bun scripts/check-architecture-file.ts <candidate> [original] [checkout-root] --deadline-ms <epoch-ms>',
  )
  process.exit(2)
}

const hubWebPlacementViolation = hubWebSourcePlacementViolation(original)
if (hubWebPlacementViolation) {
  console.log(
    JSON.stringify({
      status: 'refused',
      findings: [{ rule: 'hub-web-source-placement', dependency: hubWebPlacementViolation }],
    }),
  )
  process.exit(0)
}

if (
  /^hub\/views\/src\/docs\/.*\.[cm]?tsx?$/.test(original) &&
  !/\.(?:test|spec)\.[cm]?tsx?$/.test(original) &&
  hubViewsDocsModeLiteralLines(readFileSync(target, 'utf8')).length
) {
  console.log(
    JSON.stringify({
      status: 'refused',
      findings: [{ rule: hubViewsDocsModeLiteralRuleName, dependency: hubDataPackageName }],
    }),
  )
  process.exit(0)
}

const config = dependencyCruiserConfig()
config.forbidden = writeTimeArchitectureRules()
config.options.tsConfig.fileName = join(checkoutRoot, 'hub/web/tsconfig.json')
if (!isDeclaredHubUiSourceLocation(original)) {
  console.log(
    JSON.stringify({
      status: 'refused',
      findings: [{ rule: hubUiFolderLayerRuleName, dependency: original }],
    }),
  )
  process.exit(0)
}

if (pathOnly) {
  console.log(JSON.stringify({ status: 'ok' }))
  process.exit(0)
}

const cruiseTimeoutMs = deadlineMs - Date.now() - ARCHITECTURE_CRUISE_CLEANUP_MARGIN_MS
if (cruiseTimeoutMs <= 0) {
  console.log(
    JSON.stringify({
      status: 'unchecked',
      reason: 'architecture cruise deadline leaves no time before the cleanup margin',
    }),
  )
  process.exit(0)
}

const cruise = await runArchitectureCruise({
  entries: [target],
  extraArgs: ['--max-depth', '1', '--output-type', 'json'],
  stdout: 'pipe',
  config,
  cwd: checkoutRoot,
  timeoutMs: cruiseTimeoutMs,
})
if (cruise.timedOut) {
  console.log(
    JSON.stringify({ status: 'unchecked', reason: 'architecture cruise reached its deadline' }),
  )
  process.exit(0)
}
const result = JSON.parse(cruise.stdout) as ICruiseResult
const rulesByName = new Map(config.forbidden.map((rule) => [rule.name, rule]))

function appliesToOriginalPath(ruleName: string) {
  const from = rulesByName.get(ruleName)?.from
  if (!from || !new RegExp(from.path!).test(original!)) return false
  const pathNot = from.pathNot ? (Array.isArray(from.pathNot) ? from.pathNot : [from.pathNot]) : []
  return !pathNot.some((pattern) => new RegExp(pattern!).test(original!))
}

const findings = result.summary.violations.filter(({ from, rule }) => {
  if (rule.severity !== 'error') return false
  if (from === target && !appliesToOriginalPath(rule.name!)) return false
  return true
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
