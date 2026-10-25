#!/usr/bin/env bun
// State databases are named for their concerns; the former orchestrator filename is legacy.
// Environment names are blocking at zero; prefix-sharing TypeScript constants are named exemptions.
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_COMMAND_WORDS } from '../shared/command-spellings.ts'
import { LEGACY_ORCHESTRATOR_DATABASE } from '../shared/state-directory.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const BASELINE = 'scripts/quality/legacy-names.json'
const BASELINE_PATH = join(ROOT, BASELINE)
const SELF = 'scripts/check-legacy-names.ts'
const BESIDE_TEST = 'scripts/check-legacy-names.test.ts'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function commandPattern(name: string, verbs: readonly string[]): RegExp {
  const alternatives = [...new Set(verbs)].sort().map(escapeRegExp).join('|')
  return new RegExp(`\\b${name}\\s+(?:${alternatives})(?![\\w-])`, 'g')
}

const hubVerbs = PLATFORM_COMMAND_WORDS.map((spelling) => spelling.split(' ')[0])

const LEGACY_NAME_REGISTRY = {
  'orch-command': { blocking: true, detectors: [/\borch\s+[a-z][a-z0-9-]*(?![\w-])/g] },
  'hub-command': { blocking: true, detectors: [commandPattern('hub', hubVerbs)] },
  'legacy-binary': {
    blocking: true,
    detectors: [/bin\/orch(?![\w-])/g, /bin\/hub(?![\w-])/g],
  },
  'mcp-name': {
    blocking: true,
    detectors: [
      /mcp__orch__/g,
      /orch-ask/g,
      /mcp_servers\.orch(?![\w-])/g,
      /mcpServers\s*:\s*\{\s*(?:['"]orch['"]|orch)\s*:/g,
      /new\s+McpServer\s*\(\s*\{\s*name\s*:\s*['"]orch['"]/g,
      /\{[^{}]*\bname\s*:\s*['"]orch['"][^{}]*(?:command|target)\s*:/g,
    ],
  },
  env: {
    blocking: true,
    detectors: [/\b(?:ORCH|HUB)_[A-Z][A-Z0-9_]*\b/g, /['"`](?:ORCH|HUB)_['"`]/g],
  },
  'state-file': {
    blocking: true,
    detectors: [new RegExp(`\\b${escapeRegExp(LEGACY_ORCHESTRATOR_DATABASE)}\\b`, 'g')],
  },
} as const satisfies Record<string, { blocking: boolean; detectors: readonly RegExp[] }>

export type LegacyNameClass = keyof typeof LEGACY_NAME_REGISTRY
export type LegacyNameCounts = Record<
  LegacyNameClass,
  { total: number; files: Record<string, number> }
>

const LEGACY_NAME_CLASSES = Object.keys(LEGACY_NAME_REGISTRY) as LegacyNameClass[]

function occurrenceCount(text: string, patterns: readonly RegExp[]): number {
  let count = 0
  for (const pattern of patterns) count += [...text.matchAll(pattern)].length
  return count
}

/** Count legacy spellings in one file without knowing anything about its path. */
export function countLegacyNames(text: string): Record<LegacyNameClass, number> {
  return Object.fromEntries(
    LEGACY_NAME_CLASSES.map((name) => [
      name,
      occurrenceCount(text, LEGACY_NAME_REGISTRY[name].detectors),
    ]),
  ) as Record<LegacyNameClass, number>
}

function emptyLegacyNameCounts(): LegacyNameCounts {
  return Object.fromEntries(
    LEGACY_NAME_CLASSES.map((name) => [name, { total: 0, files: {} }]),
  ) as LegacyNameCounts
}

export function legacyNameCounts(files: Readonly<Record<string, string>>): LegacyNameCounts {
  const counts = emptyLegacyNameCounts()
  for (const [file, text] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const fileCounts = countLegacyNames(text)
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
    if (!LEGACY_NAME_REGISTRY[name].blocking) continue
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
    path === BESIDE_TEST ||
    path === BASELINE ||
    path === 'orchestrator/src/setup/setup-mcp-config.ts' ||
    path === 'orchestrator/src/setup/setup-mcp-config-migration.ts' ||
    path === 'orchestrator/src/setup/setup-mcp-config-migration.test.ts' ||
    path.startsWith('orchestrator/migrations/') ||
    path.startsWith('shared/record/migrations/') ||
    path.startsWith('hub/migrations/') ||
    isLockfile(path)
  )
}

const LEGACY_ENV_CONSTANT_EXEMPTIONS = [
  'HUB_CHANGES_NOT_YET_READABLE',
  'HUB_CHANGE_SOURCES',
  'HUB_CHANGE_SOURCE_EXCLUSIONS',
  'HUB_DATA_MODES',
  'HUB_DATA_PACKAGE',
  'HUB_DATA_ROOT',
  'HUB_DEPLOY_SITE_PACKAGE',
  'HUB_IDENTITY_SET_PAGE_SIZE',
  'HUB_MIGRATION_BACKFILL_VALUES',
  'HUB_PACKAGE_PREFIX',
  'HUB_PROJECT_NAME_TABLES',
  'HUB_SITE_PACKAGE',
  'HUB_SITE_ROOT',
  'HUB_UI_PACKAGE',
  'HUB_UI_ROOT',
  'HUB_UI_SOURCE_PREFIX',
  'HUB_UTIL_ALLOWED_IMPORT_PATHS',
  'HUB_UTIL_PACKAGE',
  'HUB_UTIL_ROOT',
  'HUB_VIEWS_PACKAGE',
  'HUB_VIEWS_ROOT',
  'HUB_WEB_ENTRY_FILES',
  'HUB_WEB_PACKAGE',
  'HUB_WEB_SOURCE_PREFIX',
  'ORCH_CLI_ENTRYPOINT',
  'ORCH_CLI_PAYLOAD',
  'ORCH_CACHE_TTL_MS',
  'ORCH_DO_OPTIONS',
  'ORCH_ROUTING',
  'ORCH_RUN_LABEL_KEY',
  'ORCH_RUN_MARKER',
] as const

function textForLegacyScan(path: string, text: string): string {
  let scanned = text
  for (const name of LEGACY_ENV_CONSTANT_EXEMPTIONS) scanned = scanned.replaceAll(name, '')
  if (
    path === 'orchestrator/src/setup/setup-environment.ts' ||
    path === 'orchestrator/src/setup/setup-environment.test.ts' ||
    path === 'orchestrator/src/setup/environment-name-migration.ts'
  ) {
    scanned = scanned.replaceAll(/\b(?:ORCH|HUB)_[A-Z][A-Z0-9_]*\b/g, '')
  }
  if (path === 'orchestrator/src/config/config-service.ts') {
    scanned = scanned.replaceAll('ORCH_RECORD_URL', '').replaceAll('ORCH_RECORD_MIGRATE_URL', '')
  }
  if (path === 'orchestrator/src/config/config-service.test.ts') {
    scanned = scanned.replaceAll('ORCH_RECORD_URL', '').replaceAll('ORCH_RECORD_MIGRATE_URL', '')
  }
  if (path !== 'orchestrator/src/verdict/verdict-rules.ts') return scanned
  // This exact value is persisted data and must remain readable by unvoid and hosted sync.
  return scanned.replaceAll('voided with orch score --void', 'voided with frozen score --void')
}

function scannedFiles(): string[] {
  const result = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed with exit ${result.exitCode ?? 'unknown'}: ${result.stderr.toString().trim() || 'no error output'}`,
    )
  }
  return result.stdout.toString().split('\0').filter(Boolean)
}

function scanFiles(): LegacyNameCounts {
  const files: Record<string, string> = {}
  for (const path of scannedFiles()) {
    if (isExempt(path)) continue
    const absolute = join(ROOT, path)
    const text = lstatSync(absolute).isSymbolicLink()
      ? readlinkSync(absolute, 'utf8')
      : readFileSync(absolute, 'utf8')
    files[path] = textForLegacyScan(path, text)
  }
  return legacyNameCounts(files)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateLegacyNameBaseline(value: unknown): LegacyNameCounts {
  if (!isRecord(value)) throw new Error('expected a JSON object')
  for (const name of LEGACY_NAME_CLASSES) {
    const entry = value[name]
    if (!isRecord(entry)) throw new Error(`missing or invalid class ${name}`)
    if (typeof entry.total !== 'number' || !Number.isFinite(entry.total)) {
      throw new Error(`class ${name} has a non-numeric total`)
    }
    if (!isRecord(entry.files)) throw new Error(`class ${name} has invalid files`)
    for (const [file, count] of Object.entries(entry.files)) {
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        throw new Error(`class ${name} file ${file} has a non-numeric count`)
      }
    }
  }
  return value as LegacyNameCounts
}

export function parseLegacyNameBaseline(text: string): LegacyNameCounts {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateLegacyNameBaseline(parsed)
}

function readBaseline(): LegacyNameCounts {
  return parseLegacyNameBaseline(readFileSync(BASELINE_PATH, 'utf8'))
}

export function legacyNameTotalLines(counts: LegacyNameCounts): string[] {
  return LEGACY_NAME_CLASSES.map((name) => `legacy ${name} ${counts[name].total}`)
}

function printTotals(counts: LegacyNameCounts): void {
  for (const line of legacyNameTotalLines(counts)) console.log(line)
}

function run(): number {
  const update = Bun.argv.slice(2).includes('--update')
  const unexpected = Bun.argv.slice(2).filter((argument) => argument !== '--update')
  if (unexpected.length > 0) {
    console.error(`unrecognized arguments: ${unexpected.join(' ')}`)
    return 1
  }
  const current = scanFiles()
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
  let baseline: LegacyNameCounts
  try {
    baseline = readBaseline()
  } catch (error) {
    console.error(
      `legacy-name baseline is invalid: ${error instanceof Error ? error.message : String(error)}\nRemedy: bun scripts/check-legacy-names.ts --update`,
    )
    return 1
  }
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
