#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEPENDENCY_AUDIT_TIMEOUT_MS = 10_000
const DEPENDENCY_AUDIT_OUTPUT_LIMIT = 500

const BUN_AUDIT_OFFLINE_ERROR_PATTERNS = [
  '/-/npm/v1/security/advisories/bulk - DNSResolveFailed',
  '/-/npm/v1/security/advisories/bulk - FailedToOpenSocket',
] as const

const BASELINE_PATH = fileURLToPath(new URL('./quality/dependency-audit.json', import.meta.url))
const REGENERATE_COMMAND = 'bun scripts/check-dependency-audit.ts --write-baseline'

export type DependencyAdvisory = { id: number; package: string }

export type DependencyAuditClassification =
  | { kind: 'result'; advisories: DependencyAdvisory[] }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'failure'; detail: string }

type AuditCommandResult =
  | { kind: 'completed'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'start-failure'; error: unknown }
  | { kind: 'timeout' }

export function compareDependencyAudit(
  current: readonly DependencyAdvisory[],
  baseline: readonly DependencyAdvisory[],
): { introduced: DependencyAdvisory[]; stale: DependencyAdvisory[] } {
  const key = (advisory: DependencyAdvisory) => `${advisory.package}\0${advisory.id}`
  const currentKeys = new Set(current.map(key))
  const baselineKeys = new Set(baseline.map(key))
  return {
    introduced: current.filter((advisory) => !baselineKeys.has(key(advisory))),
    stale: baseline.filter((advisory) => !currentKeys.has(key(advisory))),
  }
}

function sorted(advisories: DependencyAdvisory[]) {
  return advisories.sort(
    (left, right) => left.package.localeCompare(right.package) || left.id - right.id,
  )
}

function parseAdvisories(value: unknown): DependencyAdvisory[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected the audit output to be an object')
  }
  const advisories: DependencyAdvisory[] = []
  for (const [packageName, packageValue] of Object.entries(value)) {
    if (!Array.isArray(packageValue))
      throw new Error(`expected ${packageName} advisories to be an array`)
    for (const advisory of packageValue) {
      if (!advisory || typeof advisory !== 'object' || !('id' in advisory)) {
        throw new Error(`expected ${packageName} advisory to have an id`)
      }
      const id = advisory.id
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        throw new Error(`expected ${packageName} advisory id to be an integer`)
      }
      advisories.push({ id, package: packageName })
    }
  }
  return sorted(advisories)
}

function outputExcerpt(stdout: string, stderr: string): string {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  if (!output) return '[no output]'
  return output.slice(0, DEPENDENCY_AUDIT_OUTPUT_LIMIT)
}

export function classifyDependencyAudit(
  exitCode: number,
  stdout: string,
  stderr: string,
): DependencyAuditClassification {
  const offlinePattern = BUN_AUDIT_OFFLINE_ERROR_PATTERNS.find((pattern) =>
    stderr.includes(pattern),
  )
  if (offlinePattern) {
    return {
      kind: 'unavailable',
      detail: `bun audit could not reach the advisory service: ${stderr.trim()}`,
    }
  }

  const received = `bun audit exited ${exitCode}; output: ${outputExcerpt(stdout, stderr)}`
  if (exitCode !== 0 && exitCode !== 1) return { kind: 'failure', detail: received }

  try {
    return { kind: 'result', advisories: parseAdvisories(JSON.parse(stdout)) }
  } catch {
    return { kind: 'failure', detail: received }
  }
}

function readBaseline(): DependencyAdvisory[] {
  const value: unknown = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  if (!Array.isArray(value)) throw new Error(`${BASELINE_PATH}: expected a JSON array`)
  return sorted(
    value.map((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('id' in entry) ||
        !('package' in entry) ||
        typeof entry.id !== 'number' ||
        !Number.isInteger(entry.id) ||
        typeof entry.package !== 'string'
      ) {
        throw new Error(`${BASELINE_PATH}: expected entries with an integer id and package string`)
      }
      return { id: entry.id, package: entry.package }
    }),
  )
}

async function runAuditCommand(): Promise<AuditCommandResult> {
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    child = Bun.spawn(['bun', 'audit', '--json'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    return { kind: 'start-failure', error }
  }

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, DEPENDENCY_AUDIT_TIMEOUT_MS)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timeout)

  if (timedOut) {
    return { kind: 'timeout' }
  }

  return { kind: 'completed', exitCode, stdout, stderr }
}

export function classifyAuditOutcome(outcome: AuditCommandResult): DependencyAuditClassification {
  if (outcome.kind === 'timeout') {
    return {
      kind: 'unavailable',
      detail: `bun audit exceeded ${DEPENDENCY_AUDIT_TIMEOUT_MS}ms and was killed`,
    }
  }
  if (outcome.kind === 'start-failure') {
    return {
      kind: 'unavailable',
      detail: `could not start bun audit: ${String(outcome.error)}`,
    }
  }
  return classifyDependencyAudit(outcome.exitCode, outcome.stdout, outcome.stderr)
}

async function audit(): Promise<DependencyAuditClassification> {
  return classifyAuditOutcome(await runAuditCommand())
}

async function main() {
  const cliArguments = Bun.argv.slice(2)
  if (
    cliArguments.length > 1 ||
    (cliArguments.length === 1 && cliArguments[0] !== '--write-baseline')
  ) {
    throw new Error('usage: bun scripts/check-dependency-audit.ts [--write-baseline]')
  }
  const classification = await audit()
  if (classification.kind === 'unavailable') {
    console.warn(`dependency audit unavailable: ${classification.detail}`)
    return
  }
  if (classification.kind === 'failure') {
    throw new Error(`dependency audit failed: ${classification.detail}`)
  }
  const { advisories } = classification

  if (cliArguments[0] === '--write-baseline') {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(advisories, null, 2)}\n`)
    console.log(`wrote ${advisories.length} advisories to ${BASELINE_PATH}`)
    return
  }

  const { introduced, stale } = compareDependencyAudit(advisories, readBaseline())
  for (const advisory of advisories) {
    console.log(`dependency advisory: ${advisory.id} ${advisory.package}`)
  }
  for (const advisory of stale) {
    console.warn(`stale dependency audit baseline entry: ${advisory.id} ${advisory.package}`)
  }
  if (introduced.length) {
    console.error('dependency audit failed: new advisories found')
    for (const advisory of introduced) console.error(`- ${advisory.id} ${advisory.package}`)
    console.error(`regenerate the baseline with: ${REGENERATE_COMMAND}`)
    process.exit(1)
  }
  console.log(`dependency audit: ${advisories.length} baseline advisories remain`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
