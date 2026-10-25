#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import type { ICruiseResult } from 'dependency-cruiser'
import { CONCERNS } from '../shared/brand.ts'
import { modules } from './architecture.ts'
import {
  ARCHITECTURE_CRUISE_ENTRIES,
  ARCHITECTURE_CRUISE_ROOTS,
  architectureCruiseCoverageViolations,
  runArchitectureCruise,
} from './architecture-cruise.ts'
import {
  hubViewsDocsModeLiteralLines,
  hubViewsDocsModeLiteralRuleName,
} from './architecture-hub-data.ts'
import {
  architectureUndeclaredModules,
  countUndeclaredModules,
  DECLARED_SOURCE_ROOTS,
  isProductionSourceFile,
} from './architecture-undeclared-modules.ts'
import { architectureViolationRatchet } from './architecture-violation-baseline.ts'
import { importSpecifiers } from './import-scanner.ts'
import { undeclaredModulesBaseline } from './quality/undeclared-modules-baseline.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const manifestGlobs: string[] = modules.map(({ file }) => file)
const violations: string[] = []

/** Every source file a manifest module must account for, read from the checkout. */
function declaredSourceFiles() {
  const files: string[] = []
  for (const root of DECLARED_SOURCE_ROOTS) {
    for (const relative of new Glob('**/*.{ts,tsx}').scanSync({ cwd: join(ROOT, root) })) {
      files.push(`${root}/${relative}`)
    }
  }
  return files
}

for (const relative of new Glob('**/*.{ts,tsx}').scanSync({
  cwd: join(ROOT, 'hub/views/src/docs'),
})) {
  const file = `hub/views/src/docs/${relative}`
  if (!isProductionSourceFile(file)) continue
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
    if (!isProductionSourceFile(file)) continue
    const imports = importSpecifiers(readFileSync(join(ROOT, file), 'utf8'))
    for (const expression of imports.unresolvedRelative) {
      violations.push(`${file}: unresolved relative import at ${expression}`)
    }
  }
}

for (const { file } of modules) {
  if (!existsSync(join(ROOT, file))) violations.push(`manifest module names missing file ${file}`)
}

// Every non-test source file under the declared roots must belong to a manifest module; the
// frozen baseline holds the files that do not yet, and only shrinks.
const sourceFiles = declaredSourceFiles()
for (const violation of architectureUndeclaredModules(
  sourceFiles,
  manifestGlobs,
  undeclaredModulesBaseline,
)) {
  violations.push(violation)
}
const undeclaredCount = countUndeclaredModules(sourceFiles, manifestGlobs)

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
    !Array.isArray(result.summary.violations) ||
    !('modules' in result) ||
    !Array.isArray(result.modules)
  ) {
    throw new Error('dependency-cruiser JSON has no modules or summary.violations array')
  }
  return result as ICruiseResult
}

const startedAt = performance.now()
const cruise = await runArchitectureCruise({
  entries: ARCHITECTURE_CRUISE_ENTRIES,
  extraArgs: ['--output-type', 'json'],
  stdout: 'pipe',
})

const result = architectureResult(cruise.stdout)
const coverageViolations = architectureCruiseCoverageViolations({
  moduleSources: result.modules.map(({ source }) => source),
  manifestSources: modules.map(({ file }) => file),
  roots: ARCHITECTURE_CRUISE_ROOTS,
})
if (coverageViolations.length) {
  for (const violation of coverageViolations) console.error(`check-architecture: ${violation}`)
  process.exit(1)
}
const current = result.summary.violations
const errorViolations = current.filter(({ rule }) => rule.severity === 'error')
const ratchet = architectureViolationRatchet(
  errorViolations.map(({ rule, from, to }) => ({ rule: rule.name, from, to })),
)

if (ratchet.newViolations.length || ratchet.fixedBaseline.length) {
  for (const edge of ratchet.fixedBaseline) {
    console.error(
      `check-architecture: baselined violation is fixed; remove it from the baseline: ${edge.rule} ${edge.from} -> ${edge.to}`,
    )
  }
  await runArchitectureCruise({
    entries: ARCHITECTURE_CRUISE_ENTRIES,
    extraArgs: ['--output-type', 'err-long'],
  })
  process.exit(1)
}

console.log(
  `check-architecture: ok (${modules.length} manifest modules, ${result.modules.length} cruised modules, ${undeclaredCount} undeclared, depcruise ${((performance.now() - startedAt) / 1000).toFixed(2)}s)`,
)
