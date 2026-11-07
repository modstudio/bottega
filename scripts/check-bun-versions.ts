#!/usr/bin/env bun
import { startBoundedSync } from '../shared/bounded-process.ts'
import { inspectionGitEnv } from '../shared/git.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'
import { BUN_VERSION_FILE, declaredBunVersion } from './release-config.ts'

export type BunImagePin = { path: string; line: number; version: string }
export type WorkflowSource = { path: string; source: string }

/** Refuse deploy-image Bun pins that differ from the release build version. */
export function decideBunVersions(
  target: string,
  pins: readonly BunImagePin[],
): string | undefined {
  const mismatches = pins.filter((pin) => pin.version !== target)
  if (mismatches.length === 0) return undefined

  return [
    'deploy image Bun version check failed',
    ...mismatches.map((pin) => `${pin.path}:${pin.line}: Bun ${pin.version}`),
    `set every pin to ${target}`,
  ].join('\n')
}

const versionFileDeclaration = new RegExp(
  `^\\s*bun-version-file:\\s*${BUN_VERSION_FILE.replace('.', '\\.')}\\s*$`,
)

/** The lines of the workflow step that contains line `index`, ending where a sibling or parent begins. */
function stepLines(lines: readonly string[], index: number): string[] {
  let start = index
  while (start > 0 && !/^\s*- /.test(lines[start]!)) start -= 1
  const indent = lines[start]!.search(/\S/)
  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]!
    if (line.trim() && line.search(/\S/) <= indent) break
    end += 1
  }
  return lines.slice(start, end)
}

/** Refuse any setup-bun step that does not read the repository's version file, and any literal version. */
export function decideWorkflowBunVersions(
  workflows: readonly WorkflowSource[],
): string | undefined {
  const failures = workflows.flatMap(({ path, source }) => {
    const lines = source.split(/\r?\n/)
    return lines.flatMap((line, index) => {
      if (/^\s*bun-version\s*:/.test(line)) {
        return [`${path}:${index + 1}: use bun-version-file: ${BUN_VERSION_FILE}`]
      }
      if (!/^\s*(?:- )?uses:\s*oven-sh\/setup-bun@/.test(line)) return []
      if (stepLines(lines, index).some((stepLine) => versionFileDeclaration.test(stepLine))) {
        return []
      }
      return [`${path}:${index + 1}: setup-bun must declare bun-version-file: ${BUN_VERSION_FILE}`]
    })
  })
  if (failures.length === 0) return undefined
  return ['workflow Bun version check failed', ...failures].join('\n')
}

/** Refuse a missing or non-version repository declaration. */
export function decideBunVersionFile(source: string | undefined): string | undefined {
  if (declaredBunVersion(source)) return undefined
  return `${BUN_VERSION_FILE} must contain one plain version, for example 1.4.4`
}

/** Warn when this gate runs under a Bun other than the repository declaration. */
export function decideRunningBunVersion(declared: string, running: string): string | undefined {
  if (declared === running) return undefined
  return `running Bun ${running} differs from ${BUN_VERSION_FILE} ${declared}; install it with curl -fsSL https://bun.com/install | bash -s "bun-v${declared}", or update ${BUN_VERSION_FILE}`
}

function isDockerfile(path: string): boolean {
  const name = path.split('/').at(-1) ?? ''
  return name === 'Dockerfile' || name.endsWith('.Dockerfile')
}

/** The version a FROM image reference names for oven/bun, or `null` when it is another image. */
function bunVersionOf(reference: string): string | null {
  const image = /^(?:[^\s/]+\/)*oven\/bun(?::([^\s@]+))?(?:@\S+)?$/i.exec(reference)
  if (!image) return null
  // A digest or a bare image names no version this check can compare, so it is reported.
  return image[1]?.split('-')[0] ?? 'no version tag'
}

/** Every oven/bun image a Dockerfile builds from, flags and registry prefixes included. */
export function bunImagePins(path: string, source: string): BunImagePin[] {
  const pins: BunImagePin[] = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const from = /^\s*FROM\s+((?:--\S+\s+)*)(\S+)/i.exec(line)
    const version = from ? bunVersionOf(from[2]!) : null
    if (version) pins.push({ path, line: index + 1, version })
  }
  return pins
}

/** Tracked and untracked, unignored Dockerfiles, so a worker's new image is judged before it is committed. */
function repositoryDockerfiles(root: string): string[] {
  const result = startBoundedSync(
    ['git', ...nulPathListArgs(['ls-files', '--cached', '--others', '--exclude-standard'])],
    { budget: 'git-plumbing', cwd: root, env: inspectionGitEnv() },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `could not list the repository's Dockerfiles: ${result.stderr.toString().trim() || `git exited ${result.exitCode}`}; run git ls-files from the repository root`,
    )
  }
  // A tracked file deleted in the working tree builds no image.
  return splitNulPaths(result.stdout.toString())
    .filter((path) => isDockerfile(path) && existsSync(resolve(root, path)))
    .sort()
}

function workflowSources(root: string): WorkflowSource[] {
  const directory = resolve(root, '.github/workflows')
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolutePath = resolve(entry.parentPath, entry.name)
      return { path: relative(root, absolutePath), source: readFileSync(absolutePath, 'utf8') }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const versionPath = resolve(root, BUN_VERSION_FILE)
  const versionSource = existsSync(versionPath) ? readFileSync(versionPath, 'utf8') : undefined
  const versionRefusal = decideBunVersionFile(versionSource)
  if (versionRefusal) {
    console.error(versionRefusal)
    process.exit(1)
  }
  const workflowRefusal = decideWorkflowBunVersions(workflowSources(root))
  if (workflowRefusal) {
    console.error(workflowRefusal)
    process.exit(1)
  }
  const pins = repositoryDockerfiles(root).flatMap((path) =>
    bunImagePins(path, readFileSync(resolve(root, path), 'utf8')),
  )
  const declaredVersion = declaredBunVersion(versionSource)!
  const refusal = decideBunVersions(declaredVersion, pins)
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  const warning = decideRunningBunVersion(declaredVersion, Bun.version)
  if (warning) console.warn(warning)
  console.log(`deploy image Bun version check passed (${pins.length} pins)`)
}
