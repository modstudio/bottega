#!/usr/bin/env bun
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import { createHubProgram } from '../hub/src/cli-program.ts'
import { program as orchProgram } from '../orchestrator/src/cli/program.ts'

const LEGACY_NAME_CLASSES = [
  'orch-command',
  'hub-command',
  'legacy-binary',
  'mcp-name',
  'env',
  'state-file',
] as const

export type LegacyNameClass = (typeof LEGACY_NAME_CLASSES)[number]
export type LegacyNameCounts = Record<
  LegacyNameClass,
  { total: number; files: Record<string, number> }
>
export type LegacyCommandVerbs = Readonly<Record<'orch' | 'hub', readonly string[]>>

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const BASELINE_PATH = join(ROOT, 'scripts/quality/legacy-names.json')
const SELF = 'scripts/check-legacy-names.ts'
const BASELINE = 'scripts/quality/legacy-names.json'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function occurrenceCount(text: string, patterns: readonly RegExp[]): number {
  let count = 0
  for (const pattern of patterns) count += [...text.matchAll(pattern)].length
  return count
}

function commandPattern(name: 'orch' | 'hub', verbs: readonly string[]): RegExp | null {
  if (verbs.length === 0) return null
  const alternatives = [...new Set(verbs)].sort().map(escapeRegExp).join('|')
  return new RegExp(`\\b${name}\\s+(?:${alternatives})(?![\\w-])`, 'g')
}

function mcpRegistrationPatterns(): RegExp[] {
  return [
    /mcp_servers\.orch(?![\w-])/g,
    /mcpServers\s*:\s*\{\s*(?:['"]orch['"]|orch)\s*:/g,
    /new\s+McpServer\s*\(\s*\{\s*name\s*:\s*['"]orch['"]/g,
    /\{[^{}]*\bname\s*:\s*['"]orch['"][^{}]*(?:command|target)\s*:/g,
  ]
}

/** Count legacy spellings in one file without knowing anything about its path. */
export function countLegacyNames(
  text: string,
  verbs: LegacyCommandVerbs,
): Record<LegacyNameClass, number> {
  const orchCommand = commandPattern('orch', verbs.orch)
  const hubCommand = commandPattern('hub', verbs.hub)
  return {
    'orch-command': orchCommand ? occurrenceCount(text, [orchCommand]) : 0,
    'hub-command': hubCommand ? occurrenceCount(text, [hubCommand]) : 0,
    'legacy-binary': occurrenceCount(text, [/bin\/orch(?![\w-])/g, /bin\/hub(?![\w-])/g]),
    'mcp-name': occurrenceCount(text, [/mcp__orch__/g, /orch-ask/g, ...mcpRegistrationPatterns()]),
    env: occurrenceCount(text, [/\b(?:ORCH|HUB)_[A-Z][A-Z0-9_]*\b/g]),
    'state-file': occurrenceCount(text, [/\borch\.db\b/g]),
  }
}

function emptyLegacyNameCounts(): LegacyNameCounts {
  return Object.fromEntries(
    LEGACY_NAME_CLASSES.map((name) => [name, { total: 0, files: {} }]),
  ) as LegacyNameCounts
}

export function legacyNameCounts(
  files: Readonly<Record<string, string>>,
  verbs: LegacyCommandVerbs,
): LegacyNameCounts {
  const counts = emptyLegacyNameCounts()
  for (const [file, text] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const fileCounts = countLegacyNames(text, verbs)
    for (const name of LEGACY_NAME_CLASSES) {
      const count = fileCounts[name]
      if (count === 0) continue
      counts[name].files[file] = count
      counts[name].total += count
    }
  }
  return counts
}

/** Explain only growth; stale or lowered baseline entries are permitted. */
export function legacyNameGrowth(current: LegacyNameCounts, baseline: LegacyNameCounts): string[] {
  const failures: string[] = []
  for (const name of LEGACY_NAME_CLASSES) {
    const previous = baseline[name]
    const next = current[name]
    if (next.total > previous.total) {
      failures.push(`${name} total: ${previous.total} -> ${next.total}`)
    }
    for (const [file, count] of Object.entries(next.files)) {
      const before = previous.files[file] ?? 0
      if (count > before) {
        failures.push(`${name} ${file}: ${before} -> ${count} (${count - before} new occurrences)`)
      }
    }
  }
  return failures
}

/** The update operation is the same ratchet decision as the ordinary check. */
export function loweredLegacyNameBaseline(
  current: LegacyNameCounts,
  baseline: LegacyNameCounts,
): LegacyNameCounts {
  const growth = legacyNameGrowth(current, baseline)
  if (growth.length > 0) throw new Error(growth.join('\n'))
  return current
}

function commandVerbs(program: Command): string[] {
  return [
    ...new Set(program.commands.flatMap((command) => [command.name(), ...command.aliases()])),
  ].sort()
}

function registeredCommandVerbs(): LegacyCommandVerbs {
  return {
    orch: commandVerbs(orchProgram),
    hub: commandVerbs(createHubProgram()),
  }
}

function isLockfile(path: string): boolean {
  const name = path.split('/').at(-1) ?? path
  return (
    name === 'bun.lock' ||
    name === 'yarn.lock' ||
    name === 'pnpm-lock.yaml' ||
    name === 'package-lock.json' ||
    name === 'Cargo.lock' ||
    name === 'Gemfile.lock' ||
    name === 'composer.lock'
  )
}

function isExempt(path: string): boolean {
  return (
    path === SELF ||
    path === BASELINE ||
    path.startsWith('orchestrator/migrations/') ||
    path.startsWith('shared/record/migrations/') ||
    path.startsWith('hub/migrations/') ||
    isLockfile(path)
  )
}

function trackedFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed with exit ${result.exitCode ?? 'unknown'}: ${result.stderr.toString().trim() || 'no error output'}`,
    )
  }
  return result.stdout.toString().split('\0').filter(Boolean)
}

function scanTrackedFiles(): LegacyNameCounts {
  const files: Record<string, string> = {}
  for (const path of trackedFiles()) {
    if (isExempt(path)) continue
    const absolute = join(ROOT, path)
    files[path] = lstatSync(absolute).isSymbolicLink()
      ? readlinkSync(absolute, 'utf8')
      : readFileSync(absolute, 'utf8')
  }
  return legacyNameCounts(files, registeredCommandVerbs())
}

function readBaseline(): LegacyNameCounts {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as LegacyNameCounts
}

function printTotals(counts: LegacyNameCounts): void {
  for (const name of LEGACY_NAME_CLASSES) console.log(`legacy ${name} ${counts[name].total}`)
}

function run(): number {
  const update = Bun.argv.slice(2).includes('--update')
  const unexpected = Bun.argv.slice(2).filter((argument) => argument !== '--update')
  if (unexpected.length > 0) {
    console.error(`unrecognized arguments: ${unexpected.join(' ')}`)
    return 1
  }
  const current = scanTrackedFiles()
  printTotals(current)
  if (!existsSync(BASELINE_PATH)) {
    if (!update) {
      console.error(
        'legacy-name baseline is missing; run bun scripts/check-legacy-names.ts --update',
      )
      return 1
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`)
    return 0
  }
  const baseline = readBaseline()
  const growth = legacyNameGrowth(current, baseline)
  if (growth.length > 0) {
    console.error(
      `legacy-name counts grew:\n${growth.join('\n')}\nRemedy: remove the new occurrences; --update only accepts counts that shrink.`,
    )
    return 1
  }
  if (update) {
    const lowered = loweredLegacyNameBaseline(current, baseline)
    writeFileSync(BASELINE_PATH, `${JSON.stringify(lowered, null, 2)}\n`)
  }
  return 0
}

if (import.meta.main) process.exitCode = run()
