#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../shared/brand'
import { inspectionGitEnv } from '../shared/git'
import { ratchetDecision } from '../shared/ratchet'
import { concernStateDirectory } from '../shared/state-directory'
import { openChangeView } from './change-view'
import {
  cacheConfigurationHash,
  type DeadCodeFinding,
  deadCodeCacheEntriesToRemove,
  deadCodeCacheKey,
  deadCodeChangeFacts,
  deadCodeRatchetFinding,
  normalizeKnipReport,
  parseCachedFindings,
  productionSourcesAnalyzed,
  stableFinding,
  unneededExportFindings,
} from './quality/dead-code'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const BASE_CONFIG_NAMES = ['knip.jsonc', 'knip.production.jsonc'] as const
const CACHE_DIRECTORY = join(
  concernStateDirectory('orchestrator', process.env),
  'quality-reports',
  PLATFORM_SLUG,
  'dead-code',
)
const KNIP_TIMEOUT_MS = 120_000
const MAX_CACHE_ENTRIES = 10

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

function passes(root: string) {
  return [
    {
      name: 'production',
      args: ['--production', '--config', join(root, 'knip.production.jsonc')],
      issueTypes: PRODUCTION_ISSUES,
    },
    {
      name: 'default',
      args: [],
      issueTypes: [...DEPENDENCY_ISSUES, 'exports', 'types'],
    },
  ] as const
}

type PassResult = { findings: DeadCodeFinding[]; elapsedMs: number }

function runPass(root: string, pass: ReturnType<typeof passes>[number]): PassResult {
  const startedAt = performance.now()
  const result = Bun.spawnSync(
    [
      join(root, 'node_modules/.bin/knip'),
      ...pass.args,
      '--reporter',
      'json',
      '--no-progress',
      '--no-exit-code',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: KNIP_TIMEOUT_MS },
  )
  const elapsedMs = performance.now() - startedAt
  if (result.signalCode) {
    throw new Error(`knip ${pass.name} pass timed out after ${KNIP_TIMEOUT_MS}ms`)
  }
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

function assertProductionSourcesAnalyzed(findings: DeadCodeFinding[]) {
  if (!productionSourcesAnalyzed(findings)) {
    throw new Error(
      'knip production pass analyzed no sources: known-live dependency commander was reported unused',
    )
  }
}

function collectFindings(root: string) {
  const results = passes(root).map((pass) => runPass(root, pass))
  const [production, defaultMode] = results
  assertProductionSourcesAnalyzed(production!.findings)
  const dependencyFindings = defaultMode!.findings.filter((finding) =>
    DEPENDENCY_ISSUES.includes(finding.issueType as (typeof DEPENDENCY_ISSUES)[number]),
  )
  return {
    findings: [
      ...production!.findings,
      ...dependencyFindings,
      ...unneededExportFindings(production!.findings, defaultMode!.findings),
    ],
    productionMs: production!.elapsedMs,
    defaultMs: defaultMode!.elapsedMs,
  }
}

function git(args: string[], step: string) {
  const result = Bun.spawnSync(['git', '-C', ROOT, '--no-optional-locks', ...args], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || 'no error output'
    throw new Error(`check-dead-code: ${step} failed: ${detail}`)
  }
  return result.stdout.toString()
}

function resolvedCommit(base: string) {
  return git(['rev-parse', '--verify', `${base}^{commit}`], 'resolve base commit').trim()
}

function installedKnipVersion() {
  const value = JSON.parse(readFileSync(join(ROOT, 'node_modules/knip/package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof value.version !== 'string' || !value.version) {
    throw new Error('check-dead-code: installed Knip package has no version')
  }
  return value.version
}

function installedDependencyDirectories() {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    workspaces?: unknown
  }
  const workspaces = Array.isArray(packageJson.workspaces)
    ? packageJson.workspaces.filter((value): value is string => typeof value === 'string')
    : []
  return ['', ...workspaces].flatMap((workspace) => {
    const source = join(ROOT, workspace, 'node_modules')
    return existsSync(source) ? [{ workspace, source }] : []
  })
}

function baseConfiguration(commit: string) {
  return BASE_CONFIG_NAMES.map((name) => ({
    name,
    content: git(['show', `${commit}:${name}`], `read ${name} at base commit`),
  }))
}

function readCache(path: string) {
  if (!existsSync(path)) return { status: 'missing' as const }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { status: 'unreadable' as const }
  }
  const findings = parseCachedFindings(text)
  return findings ? { status: 'hit' as const, findings } : { status: 'invalid' as const }
}

function pruneCache(justWritten: string) {
  const entries = readdirSync(CACHE_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      modifiedMs: statSync(join(CACHE_DIRECTORY, entry.name)).mtimeMs,
    }))
  for (const name of deadCodeCacheEntriesToRemove(entries, justWritten, MAX_CACHE_ENTRIES)) {
    try {
      rmSync(join(CACHE_DIRECTORY, name))
    } catch (error) {
      console.warn(`dead code base cache could not remove ${name}: ${String(error)}`)
    }
  }
}

function writeCache(path: string, findings: DeadCodeFinding[]) {
  mkdirSync(CACHE_DIRECTORY, { recursive: true })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(findings.map(stableFinding), null, 2)}\n`, {
      flag: 'wx',
    })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function copyBase(commit: string) {
  const directory = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-dead-code-`))
  const archive = join(directory, 'base.tar')
  const tree = join(directory, 'tree')
  mkdirSync(tree)
  try {
    git(['archive', '--format=tar', '-o', archive, commit], 'base copy archive')
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  const extractResult = Bun.spawnSync(['tar', '-xf', archive, '-C', tree], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (extractResult.exitCode !== 0) {
    const detail = extractResult.stderr.toString().trim() || 'no error output'
    rmSync(directory, { recursive: true, force: true })
    throw new Error(`check-dead-code: base copy extraction step failed: ${detail}`)
  }
  rmSync(archive)
  try {
    for (const dependencyDirectory of installedDependencyDirectories()) {
      const destination = join(tree, dependencyDirectory.workspace, 'node_modules')
      mkdirSync(dirname(destination), { recursive: true })
      symlinkSync(dependencyDirectory.source, destination, 'dir')
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw new Error(`check-dead-code: base dependency link step failed: ${String(error)}`)
  }
  return { directory, tree }
}

function buildBaseFindings(commit: string) {
  const copy = copyBase(commit)
  try {
    return collectFindings(copy.tree).findings.map(stableFinding)
  } catch (error) {
    throw new Error(
      `check-dead-code: base Knip analysis step failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    rmSync(copy.directory, { recursive: true, force: true })
  }
}

function cachedBaseFindings(commit: string, knipVersion: string, configurationHash: string) {
  const key = deadCodeCacheKey({ commit, knipVersion, configurationHash })
  const path = join(CACHE_DIRECTORY, `${key}.json`)
  const cached = readCache(path)
  if (cached.status === 'hit') {
    console.log(`dead code base cache reused: ${basename(path)}`)
    return cached.findings
  }
  console.log(`dead code base cache ${cached.status}; rebuilding: ${basename(path)}`)
  const findings = buildBaseFindings(commit)
  writeCache(path, findings)
  pruneCache(basename(path))
  return findings
}

function describeFinding(finding: DeadCodeFinding) {
  return `${finding.file}${finding.line ? `:${finding.line}` : ''} ${finding.issueType} ${finding.symbol}`
}

async function checkDeadCode(base: string) {
  const commit = resolvedCommit(base)
  const view = openChangeView({ cwd: ROOT, base: commit, mode: 'worktree' })
  const current = collectFindings(ROOT)
  const unchangedCurrentCommit = commit === resolvedCommit('HEAD') && view.entries.length === 0
  const baseFindings = unchangedCurrentCommit
    ? current.findings
    : cachedBaseFindings(
        commit,
        installedKnipVersion(),
        cacheConfigurationHash(baseConfiguration(commit)),
      )
  const refused = ratchetDecision({
    base: baseFindings.map(deadCodeRatchetFinding),
    head: current.findings.map(deadCodeRatchetFinding),
    change: deadCodeChangeFacts(view.facts.renames),
  })
  const identity = (finding: ReturnType<typeof deadCodeRatchetFinding>) =>
    JSON.stringify([finding.file, finding.rule])
  const currentByIdentity = new Map(
    current.findings.map((finding) => [identity(deadCodeRatchetFinding(finding)), finding]),
  )
  for (const finding of refused) {
    const original = currentByIdentity.get(identity(finding))
    if (!original) throw new Error('check-dead-code: refused finding lost its source identity')
    const remedy =
      original.issueType === 'unneededExports' || original.issueType === 'unneededTypes'
        ? 'remove the export keyword'
        : 'delete it and any test that exists only for it'
    console.error(`${describeFinding(original)} is new; ${remedy}`)
  }
  console.log(`dead code: ${current.findings.length} findings remain`)
  if (refused.length) return false
  console.log(
    `check-dead-code: ok (production ${current.productionMs.toFixed(0)}ms, default ${current.defaultMs.toFixed(0)}ms)`,
  )
  return true
}

function parseBase(argv: string[]) {
  if (argv.length === 1 && argv[0]!.startsWith('--base=') && argv[0]!.length > 7) {
    return argv[0]!.slice(7)
  }
  throw new Error('usage: check-dead-code.ts --base=<commit>')
}

if (import.meta.main) {
  try {
    if (!(await checkDeadCode(parseBase(Bun.argv.slice(2))))) process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
