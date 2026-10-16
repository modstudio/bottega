#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ICruiseResult } from 'dependency-cruiser'
import {
  dependencyCruiserConfig,
  hubWebViewDataRule,
  writeTimeArchitectureRules,
} from './architecture.ts'
import { runArchitectureCruise } from './architecture-cruise.ts'
import { hubUiFolderLayerRuleName, hubUiLayerFolders } from './architecture-ui-layers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
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
const checkoutRoot = process.argv[4] ?? ROOT

if (!target || !original) {
  console.error(
    'usage: bun scripts/check-architecture-file.ts <candidate> [original] [checkout-root]',
  )
  process.exit(2)
}

const config = dependencyCruiserConfig()
config.forbidden = writeTimeArchitectureRules()
config.options.tsConfig.fileName = join(checkoutRoot, 'hub/web/tsconfig.json')
const declaredLayerFolders = new Set(hubUiLayerFolders)
const originalFolder = original.match(/^hub\/ui\/src\/([^/]+)\//)?.[1]
const undeclaredUiFolder =
  originalFolder !== undefined &&
  originalFolder !== 'styles' &&
  !declaredLayerFolders.has(originalFolder) &&
  !/\.(?:test|spec)\.[cm]?tsx?$/.test(original)

if (undeclaredUiFolder) {
  console.log(
    JSON.stringify({
      status: 'refused',
      findings: [{ rule: hubUiFolderLayerRuleName, dependency: originalFolder }],
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
})
const result = JSON.parse(cruise.stdout) as ICruiseResult
const rulesByName = new Map(config.forbidden.map((rule) => [rule.name, rule]))

function appliesToOriginalPath(ruleName: string) {
  const from = rulesByName.get(ruleName)?.from
  if (!from || !new RegExp(from.path).test(original)) return false
  const pathNot = from.pathNot ? (Array.isArray(from.pathNot) ? from.pathNot : [from.pathNot]) : []
  return !pathNot.some((pattern) => new RegExp(pattern).test(original))
}

const findings = result.summary.violations.filter(({ from, rule }) => {
  if (rule.severity !== 'error') return false
  if (from === target && !appliesToOriginalPath(rule.name)) return false
  if (rule.name === hubWebViewDataRule.name) {
    return from !== target || !VIEW_DATA_BASELINE.has(original)
  }
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
