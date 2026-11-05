#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'
import { RELEASE_BUN_VERSION } from './release-config.ts'

export type BunImagePin = { path: string; line: number; version: string }

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
  const result = Bun.spawnSync(
    ['git', ...nulPathListArgs(['ls-files', '--cached', '--others', '--exclude-standard'])],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (!result.success) {
    throw new Error(
      `could not list the repository's Dockerfiles: ${result.stderr.toString().trim() || `git exited ${result.exitCode}`}; run git ls-files from the repository root`,
    )
  }
  // A tracked file deleted in the working tree builds no image.
  return splitNulPaths(result.stdout.toString())
    .filter((path) => isDockerfile(path) && existsSync(resolve(root, path)))
    .sort()
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const pins = repositoryDockerfiles(root).flatMap((path) =>
    bunImagePins(path, readFileSync(resolve(root, path), 'utf8')),
  )
  const refusal = decideBunVersions(RELEASE_BUN_VERSION, pins)
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  console.log(`deploy image Bun version check passed (${pins.length} pins)`)
}
