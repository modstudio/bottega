#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import { CONCERNS } from '../shared/brand.ts'
import { architectureRules, modules } from './architecture.ts'
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

type KnownViolation = {
  from: string
  to: string
  unresolvedTo?: string
  rule: { name: string }
}

async function staleHubWebDataAccessViolations() {
  const directory = mkdtempSync(join(tmpdir(), 'hub-web-data-access-baseline-'))
  const candidate = join(directory, 'known-violations.json')
  try {
    copyFileSync(HUB_WEB_DATA_ACCESS_BASELINE, candidate)
    const result = await runArchitectureCruise({
      entries: ARCHITECTURE_CRUISE_ROOTS,
      extraArgs: ['--baseline', candidate, '--baseline-mode', 'shrink-only'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      process.stderr.write(result.stderr)
      process.exit(result.exitCode)
    }
    const baseline = JSON.parse(
      readFileSync(HUB_WEB_DATA_ACCESS_BASELINE, 'utf8'),
    ) as KnownViolation[]
    const current = JSON.parse(readFileSync(candidate, 'utf8')) as KnownViolation[]
    const currentEntries = new Set(current.map((entry) => JSON.stringify(entry)))
    return baseline.filter((entry) => !currentEntries.has(JSON.stringify(entry)))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const staleViolations = await staleHubWebDataAccessViolations()
if (staleViolations.length) {
  for (const violation of staleViolations) {
    console.error(
      `${violation.from} -> ${violation.unresolvedTo ?? violation.to} (${violation.rule.name}): stale known violation; delete this stale entry from scripts/quality/hub-web-views-do-not-fetch-data-or-read-hub-mode-known-violations.json`,
    )
  }
  process.exit(1)
}

const startedAt = performance.now()
const { exitCode } = await runArchitectureCruise({
  entries: ARCHITECTURE_CRUISE_ROOTS,
  extraArgs: ['--ignore-known', HUB_WEB_DATA_ACCESS_BASELINE, '--output-type', 'err-long'],
})
if (exitCode !== 0) process.exit(exitCode)

console.log(
  `check-architecture: ok (${modules.length} manifest modules, depcruise ${((performance.now() - startedAt) / 1000).toFixed(2)}s)`,
)
