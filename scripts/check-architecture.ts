#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import type { ICruiseResult } from 'dependency-cruiser'
import { CONCERNS } from '../shared/brand.ts'
import { architectureRules, modules } from './architecture.ts'
import { ARCHITECTURE_CRUISE_ROOTS, runArchitectureCruise } from './architecture-cruise.ts'
import {
  hubViewsDocsModeLiteralLines,
  hubViewsDocsModeLiteralRuleName,
} from './architecture-hub-data.ts'
import { importSpecifiers } from './import-scanner.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const CONCERN = /^\/\/ concern: ([a-z0-9-]+)$/
const manifestFiles = new Set(modules.map(({ file }) => file))
const manifestRules = new Set(architectureRules().forbidden.map(({ name }) => name))
const violations: string[] = []

function isProductionTypeScript(path: string) {
  return !/(^|\/)tests?\//.test(path) && !/\.(?:test|spec)\.[cm]?tsx?$/.test(path)
}

for (const relative of new Glob('**/*.{ts,tsx}').scanSync({
  cwd: join(ROOT, 'hub/views/src/docs'),
})) {
  const file = `hub/views/src/docs/${relative}`
  if (!isProductionTypeScript(file)) continue
  for (const line of hubViewsDocsModeLiteralLines(readFileSync(join(ROOT, file), 'utf8'))) {
    violations.push(
      `${file}:${line} (${hubViewsDocsModeLiteralRuleName}): docs components receive mode-neutral props`,
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

const result = architectureResult(cruise.stdout)
const current = result.summary.violations
const errorViolations = current.filter(({ rule }) => rule.severity === 'error')

if (errorViolations.length) {
  await runArchitectureCruise({
    entries: ARCHITECTURE_CRUISE_ROOTS,
    extraArgs: ['--output-type', 'err-long'],
  })
  process.exit(1)
}

console.log(
  `check-architecture: ok (${modules.length} manifest modules, depcruise ${((performance.now() - startedAt) / 1000).toFixed(2)}s)`,
)
