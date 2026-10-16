#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import type { ICruiseResult } from 'dependency-cruiser'
import { CONCERNS } from '../shared/brand.ts'
import { architectureRules, modules } from './architecture.ts'
import {
  hubWebDocsModeLiteralLines,
  hubWebDocsModeLiteralRuleName,
} from './architecture-hub-data.ts'
import { ARCHITECTURE_CRUISE_ROOTS, runArchitectureCruise } from './architecture-cruise.ts'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const HUB_WEB_DATA_ACCESS_BASELINE = join(
  ROOT,
  'scripts/quality/hub-web-views-do-not-fetch-data-or-read-hub-mode-known-violations.json',
)
const CONCERN = /^\/\/ concern: ([a-z0-9-]+)$/
const manifestFiles = new Set(modules.map(({ file }) => file))
const manifestRules = new Set(architectureRules().forbidden.map(({ name }) => name))
const violations: string[] = []

function isProductionTypeScript(path: string) {
  return !/(^|\/)tests?\//.test(path) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(path)
}

for (const relative of new Glob('**/*.{ts,tsx}').scanSync({ cwd: join(ROOT, 'hub/web/src/docs') })) {
  const file = `hub/web/src/docs/${relative}`
  if (!isProductionTypeScript(file)) continue
  for (const line of hubWebDocsModeLiteralLines(readFileSync(join(ROOT, file), 'utf8'))) {
    violations.push(
      `${file}:${line} (${hubWebDocsModeLiteralRuleName}): docs components receive mode-neutral props`,
    )
  }
}

for (const root of [...CONCERNS, 'shared']) {
  const directory = join(ROOT, root)
  if (!existsSync(directory)) continue
  for (const relative of new Glob('**/*.{ts,tsx}').scanSync({ cwd: directory })) {
    const file = `${root}/${relative}`
    if (!isProductionTypeScript(file)) continue
    const imports = importSpecifiers(readFileSync(join(ROOT, file), 'utf8'))
    for (const expression of imports.unresolvedRelative) {
      violations.push(`${file}: unresolved relative import at ${expression}`)
    }
  }
}

for (const { file } of modules) {
  if (!existsSync(join(ROOT, file))) violations.push(`manifest module names missing file ${file}`)
}

for (const root of ['orchestrator/src', 'hub/src']) {
  for (const relative of new Glob('**/*.{ts,tsx}').scanSync({ cwd: join(ROOT, root) })) {
    const file = `${root}/${relative}`
    const firstLine = readFileSync(join(ROOT, file), 'utf8').split('\n', 1)[0]!
    const concern = firstLine.match(CONCERN)?.[1]
    if (!concern || manifestFiles.has(file)) continue
    const customBoundary = `scripts/check-${concern}-boundary.ts`
    if (
      !existsSync(join(ROOT, customBoundary)) &&
      !manifestRules.has(`import-${concern}-boundary`)
    ) {
      violations.push(
        `${file}: missing manifest module or ${customBoundary} (canon 10-code: A module is one concern)`,
      )
    }
  }
}

if (violations.length) {
  for (const violation of violations) console.error(violation)
  process.exit(1)
}

function architectureResult(stdout: string): ICruiseResult {
  const result: unknown = JSON.parse(stdout)
  if (
    typeof result !== 'object' ||
    result === null ||
    !('summary' in result) ||
    typeof result.summary !== 'object' ||
    result.summary === null ||
    !('violations' in result.summary) ||
    !Array.isArray(result.summary.violations)
  ) {
    throw new Error('dependency-cruiser JSON has no summary.violations array')
  }
  return result as ICruiseResult
}

const startedAt = performance.now()
const cruise = await runArchitectureCruise({
  entries: ARCHITECTURE_CRUISE_ROOTS,
  extraArgs: ['--output-type', 'json'],
  stdout: 'pipe',
})

const HUB_WEB_DATA_ACCESS_RULE = 'hub-web-views-do-not-fetch-data-or-read-hub-mode'
const baseline = JSON.parse(readFileSync(HUB_WEB_DATA_ACCESS_BASELINE, 'utf8')) as string[]
const baselineFiles = new Set(baseline)
const result = architectureResult(cruise.stdout)
const current = result.summary.violations
const currentBaselineFiles = new Set(
  current.filter(({ rule }) => rule.name === HUB_WEB_DATA_ACCESS_RULE).map(({ from }) => from),
)
const staleBaselineFiles = baseline.filter((file) => !currentBaselineFiles.has(file))
const remainingErrorViolations = current.filter(
  ({ from, rule }) =>
    rule.severity === 'error' &&
    (rule.name !== HUB_WEB_DATA_ACCESS_RULE || !baselineFiles.has(from)),
)

for (const file of staleBaselineFiles) {
  console.error(
    `${file} (${HUB_WEB_DATA_ACCESS_RULE}): stale known violation; delete this stale entry from scripts/quality/hub-web-views-do-not-fetch-data-or-read-hub-mode-known-violations.json`,
  )
}

if (staleBaselineFiles.length || remainingErrorViolations.length) {
  const generatedDirectory = mkdtempSync(join(tmpdir(), 'architecture-known-violations-'))
  const generatedBaseline = join(generatedDirectory, 'known-violations.json')
  const knownViolations = current.filter(
    ({ from, rule }) => rule.name === HUB_WEB_DATA_ACCESS_RULE && baselineFiles.has(from),
  )
  try {
    writeFileSync(generatedBaseline, JSON.stringify(knownViolations, null, 2))
    await runArchitectureCruise({
      entries: ARCHITECTURE_CRUISE_ROOTS,
      extraArgs: ['--output-type', 'err-long', '--ignore-known', generatedBaseline],
    })
  } finally {
    rmSync(generatedDirectory, { recursive: true, force: true })
  }
  process.exit(1)
}

console.log(
  `check-architecture: ok (${modules.length} manifest modules, depcruise ${((performance.now() - startedAt) / 1000).toFixed(2)}s)`,
)
