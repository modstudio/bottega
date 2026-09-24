#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  compareDeadCodeFindings,
  type DeadCodeFinding,
  normalizeKnipReport,
  productionSourcesAnalyzed,
  stableFinding,
  unneededExportFindings,
} from './quality/dead-code'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const KNIP = `${ROOT}/node_modules/.bin/knip`
const BASELINE = `${ROOT}/scripts/quality/dead-code.json`
const BASELINE_LABEL = 'scripts/quality/dead-code.json'
const PRODUCTION_CONFIG = `${ROOT}/knip.production.jsonc`

const PRODUCTION_ISSUES = [
  'files',
  'dependencies',
  'unlisted',
  'unresolved',
  'exports',
  'nsExports',
  'types',
  'nsTypes',
  'enumMembers',
  'namespaceMembers',
] as const
const DEPENDENCY_ISSUES = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'unresolved',
] as const

const PASSES = [
  {
    name: 'production',
    args: ['--production', '--config', PRODUCTION_CONFIG],
    issueTypes: PRODUCTION_ISSUES,
  },
  {
    name: 'default',
    args: [],
    issueTypes: [...DEPENDENCY_ISSUES, 'exports', 'types'],
  },
] as const

type PassResult = { findings: DeadCodeFinding[]; elapsedMs: number }

function runPass(pass: (typeof PASSES)[number]): PassResult {
  const startedAt = performance.now()
  const result = Bun.spawnSync(
    [KNIP, ...pass.args, '--reporter', 'json', '--no-progress', '--no-exit-code'],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  const elapsedMs = performance.now() - startedAt
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim()
    throw new Error(`knip ${pass.name} pass failed${detail ? `: ${detail}` : ''}`)
  }
  try {
    return {
      findings: normalizeKnipReport(JSON.parse(result.stdout.toString()), pass.issueTypes),
      elapsedMs,
    }
  } catch (error) {
    throw new Error(`knip ${pass.name} pass returned invalid JSON: ${String(error)}`)
  }
}

function readBaseline() {
  if (!existsSync(BASELINE)) return []
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as DeadCodeFinding[]
}

function writeBaseline(findings: DeadCodeFinding[]) {
  writeFileSync(BASELINE, `${JSON.stringify(findings.map(stableFinding), null, 2)}\n`)
}

function describeFinding(finding: DeadCodeFinding) {
  return `${finding.file}${finding.line ? `:${finding.line}` : ''} ${finding.issueType} ${finding.symbol}`
}

function assertProductionSourcesAnalyzed(findings: DeadCodeFinding[]) {
  if (!productionSourcesAnalyzed(findings)) {
    throw new Error(
      'knip production pass analyzed no sources: known-live dependency commander was reported unused',
    )
  }
}

function checkDeadCode(write = process.argv.includes('--write-baseline')) {
  const results = PASSES.map(runPass)
  assertProductionSourcesAnalyzed(results[0]!.findings)
  const [production, defaultMode] = results
  const dependencyFindings = defaultMode!.findings.filter((finding) =>
    DEPENDENCY_ISSUES.includes(finding.issueType as (typeof DEPENDENCY_ISSUES)[number]),
  )
  const unneededExports = unneededExportFindings(production!.findings, defaultMode!.findings)
  const current = [...production!.findings, ...dependencyFindings, ...unneededExports]
  if (write) {
    writeBaseline(current)
    console.log(`check-dead-code: wrote ${current.length} findings to ${BASELINE_LABEL}`)
    return true
  }

  const { introduced, vanished } = compareDeadCodeFindings(readBaseline(), current)
  for (const finding of introduced) {
    const remedy =
      finding.issueType === 'unneededExports' || finding.issueType === 'unneededTypes'
        ? 'remove the export keyword'
        : 'delete it and any test that exists only for it'
    console.error(`${describeFinding(finding)} is new; ${remedy}`)
  }
  for (const finding of vanished) {
    console.error(`${describeFinding(finding)} no longer appears`)
  }
  if (vanished.length) {
    console.error(
      `baseline tightened; run bun scripts/check-dead-code.ts --write-baseline and commit ${BASELINE_LABEL}`,
    )
  }
  if (introduced.length || vanished.length) return false

  console.log(
    `check-dead-code: ok (${current.length} findings; production ${production!.elapsedMs.toFixed(0)}ms, default ${defaultMode!.elapsedMs.toFixed(0)}ms)`,
  )
  return true
}

if (import.meta.main) {
  try {
    if (!checkDeadCode()) process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
