#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS, type CheckLeg, type IsolatedTestLeg, legIsolatesTests } from './check-plan.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

type PackageManifest = { scripts?: { test?: string } }

export function testIsolationViolation(
  leg: IsolatedTestLeg,
  manifest: PackageManifest,
): string | undefined {
  const file = `${leg.directory}/package.json`
  const testScript = manifest.scripts?.test
  if (testScript?.split(/\s+/).includes('--isolate')) return undefined
  return `${file}: CHECK_LEGS marks ${JSON.stringify(leg.directory)} isolateTests; add --isolate to scripts.test`
}

export function testIsolationViolations(
  legs: readonly CheckLeg[],
  manifests: Readonly<Record<string, PackageManifest>>,
): string[] {
  const isolatedLegs = legs.filter(legIsolatesTests)
  const missingMarkerViolation =
    isolatedLegs.length === 0
      ? [
          'scripts/check-plan.ts: no CHECK_LEGS leg is marked isolateTests; mark the hub leg isolateTests: true',
        ]
      : []

  return [
    ...missingMarkerViolation,
    ...legs.flatMap((leg) => {
      const manifest = manifests[leg.directory] ?? {}
      if (legIsolatesTests(leg)) {
        const violation = testIsolationViolation(leg, manifest)
        return violation ? [violation] : []
      }
      if (manifest.scripts?.test?.split(/\s+/).includes('--isolate')) {
        return [
          `${leg.directory}/package.json: scripts.test carries --isolate but CHECK_LEGS does not mark ${JSON.stringify(leg.directory)} isolateTests; mark that leg isolateTests: true`,
        ]
      }
      return []
    }),
  ]
}

function run(): number {
  const startedAt = performance.now()
  const manifests = Object.fromEntries(
    CHECK_LEGS.map((leg) => [
      leg.directory,
      JSON.parse(readFileSync(join(ROOT, leg.directory, 'package.json'), 'utf8')),
    ]),
  )
  const violations = testIsolationViolations(CHECK_LEGS, manifests)
  for (const violation of violations) console.error(violation)
  if (violations.length > 0) return 1
  const isolatedLegs = CHECK_LEGS.filter(legIsolatesTests)
  console.log(
    `check-test-isolation: ok (${isolatedLegs.map((leg) => leg.directory).join(', ')}; ${(performance.now() - startedAt).toFixed(1)}ms)`,
  )
  return 0
}

if (import.meta.main) process.exit(run())
