#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
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

function bunImagePins(path: string, source: string): BunImagePin[] {
  const pins: BunImagePin[] = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = /^\s*FROM\s+oven\/bun:([^\s-]+)(?:-[^\s]+)?(?:\s|$)/i.exec(line)
    if (match) pins.push({ path, line: index + 1, version: match[1]! })
  }
  return pins
}

function trackedDockerfiles(root: string): string[] {
  const result = Bun.spawnSync(['git', ...nulPathListArgs(['ls-files'])], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (!result.success) {
    throw new Error(
      `could not list tracked Dockerfiles: ${result.stderr.toString().trim() || `git exited ${result.exitCode}`}; run git ls-files from the repository root`,
    )
  }
  return splitNulPaths(result.stdout.toString()).filter(isDockerfile).sort()
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const pins = trackedDockerfiles(root).flatMap((path) =>
    bunImagePins(path, readFileSync(resolve(root, path), 'utf8')),
  )
  const refusal = decideBunVersions(RELEASE_BUN_VERSION, pins)
  if (refusal) {
    console.error(refusal)
    process.exit(1)
  }
  console.log(`deploy image Bun version check passed (${pins.length} pins)`)
}
