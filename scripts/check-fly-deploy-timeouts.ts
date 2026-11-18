#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBoundedSync } from '../shared/bounded-process.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'

/** Ruled Fly deploy timeout floor; lowering it is an operator ruling. */
export const FLY_DEPLOY_TIMEOUT_FLOOR_MS = 15 * 60 * 1_000

type FlyDeployTimeoutInputs = {
  path: string
  text: string
  floorMs: number
}

function namedValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

function flyDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const part = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy
  const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const
  let total = 0
  let offset = 0
  for (const match of value.matchAll(part)) {
    if (match.index !== offset) return undefined
    total += Number(match[1]) * unitMs[match[2] as keyof typeof unitMs]
    offset += match[0].length
  }
  return offset === value.length && Number.isFinite(total) ? total : undefined
}

function timeoutFinding(input: {
  path: string
  key: 'wait_timeout' | 'release_command_timeout'
  value: unknown
  floorMs: number
}): string | undefined {
  const { path, key, value, floorMs } = input
  const floorMinutes = floorMs / 60_000
  if (value === undefined) {
    return `${path}: [deploy].${key} value <missing>; set ${key} = "${floorMinutes}m" under [deploy]`
  }
  const parsedMs = flyDurationMs(value)
  if (parsedMs === undefined) {
    return `${path}: [deploy].${key} value ${namedValue(value)} does not parse as a Fly duration; set ${key} = "${floorMinutes}m" under [deploy] using ms, s, m or h units`
  }
  if (parsedMs < floorMs) {
    return `${path}: [deploy].${key} value ${namedValue(value)} is below the ${floorMinutes}m floor; raise ${key} to at least "${floorMinutes}m"; lowering the floor is an operator ruling in scripts/check-fly-deploy-timeouts.ts`
  }
  return undefined
}

/** Decide whether a tracked Fly config pins deploy timeouts at or above the ruled floor. */
export function decideFlyDeployTimeouts({ path, text, floorMs }: FlyDeployTimeoutInputs): string[] {
  let parsed: Record<string, unknown>
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>
  } catch (error) {
    return [
      `${path}: [deploy] timeout values <unreadable because TOML parsing failed: ${String(error)}>; fix the TOML syntax in ${path}, then set wait_timeout and any required release_command_timeout to "${floorMs / 60_000}m"`,
    ]
  }

  const deploy =
    typeof parsed.deploy === 'object' && parsed.deploy !== null
      ? (parsed.deploy as Record<string, unknown>)
      : {}
  const findings = [
    timeoutFinding({ path, key: 'wait_timeout', value: deploy.wait_timeout, floorMs }),
  ]
  if (deploy.release_command !== undefined) {
    findings.push(
      timeoutFinding({
        path,
        key: 'release_command_timeout',
        value: deploy.release_command_timeout,
        floorMs,
      }),
    )
  }
  return findings.filter((finding): finding is string => finding !== undefined)
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const tracked = startBoundedSync(['git', ...nulPathListArgs(['ls-files', '--', '*fly.toml'])], {
    budget: 'git-plumbing',
    cwd: root,
  })
  if (tracked.exitCode !== 0) {
    console.error(
      `Fly deploy timeout check failed: git ls-files could not list tracked fly.toml files; restore git access and rerun scripts/check-fly-deploy-timeouts.ts`,
    )
    process.exit(1)
  }
  const paths = splitNulPaths(tracked.stdout)
  if (paths.length === 0) {
    console.error(
      'Fly deploy timeout check failed: git ls-files found zero tracked fly.toml files; track the Fly config or restore the checkout and rerun scripts/check-fly-deploy-timeouts.ts',
    )
    process.exit(1)
  }
  const findings = paths.flatMap((path) =>
    decideFlyDeployTimeouts({
      path,
      text: readFileSync(resolve(root, path), 'utf8'),
      floorMs: FLY_DEPLOY_TIMEOUT_FLOOR_MS,
    }),
  )
  if (findings.length) {
    console.error('Fly deploy timeout check failed')
    for (const finding of findings) console.error(finding)
    process.exit(1)
  }
  console.log(
    `Fly deploy timeout check passed (${paths.length} files at or above ${FLY_DEPLOY_TIMEOUT_FLOOR_MS}ms)`,
  )
}
