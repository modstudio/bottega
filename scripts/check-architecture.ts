#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import type { ICruiseResult } from 'dependency-cruiser'
import { CONCERNS } from '../shared/brand.ts'
import { inspectionGitEnv } from '../shared/git'
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
  parseUndeclaredModulesBaseline,
} from './architecture-undeclared-modules.ts'
import { architectureViolationRatchet } from './architecture-violation-baseline.ts'
import { importSpecifiers } from './import-scanner.ts'
import { undeclaredModulesBaseline } from './quality/undeclared-modules-baseline.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const BASELINE_FILE = 'scripts/quality/undeclared-modules-baseline.ts'
const manifestFiles: string[] = modules.map(({ file }) => file)
const violations: string[] = []

/** The `--base=<commit>` the gate passes; the frozen baseline is compared against it. */
function baseArgumentOrExit(argv: readonly string[]): string | null {
  let base: string | null = null
  for (const argument of argv) {
    if (!argument.startsWith('--base=') || argument.length === '--base='.length || base !== null) {
      console.error('usage: bun scripts/check-architecture.ts [--base=<commit>]')
      process.exit(1)
    }
    base = argument.slice('--base='.length)
  }
  return base
}

/**
 * The baseline as the base revision froze it. A revision that has no baseline module yet, or
 * no base argument at all, leaves nothing to shrink from.
 */
function baseBaselineOrExit(commit: string | null): string[] | null {
  if (!commit) return null
  const result = Bun.spawnSync(['git', 'show', `${commit}:${BASELINE_FILE}`], {
    cwd: ROOT,
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode === 0) return parseUndeclaredModulesBaseline(result.stdout.toString())
  const error = result.stderr.toString()
  if (error.includes('does not exist in') || error.includes('exists on disk, but not in'))
    return null
  console.error(
    `could not read the base undeclared-modules baseline at ${commit}: ${error.trim() || `git show exited ${result.exitCode ?? 'unknown'}`}`,
  )
  process.exit(1)
}

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

// The baseline is judged as the base revision froze it, so a baseline line cannot be added
// alongside the undeclared file it hides.
const base = baseArgumentOrExit(Bun.argv.slice(2))
const baseUndeclaredBaseline = baseBaselineOrExit(base)

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
  manifestFiles,
  undeclaredModulesBaseline,
  baseUndeclaredBaseline,
)) {
  violations.push(violation)
}
const undeclaredCount = countUndeclaredModules(sourceFiles, manifestFiles)

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
