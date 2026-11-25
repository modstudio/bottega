#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECK_LEGS } from './check-plan.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

type IsolatedLeg = Pick<(typeof CHECK_LEGS)[number], 'directory'> & { isolateTests: true }
type PackageManifest = { scripts?: { test?: string } }

export function testIsolationViolation(
  leg: IsolatedLeg,
  manifest: PackageManifest,
): string | undefined {
  const file = `${leg.directory}/package.json`
  const testScript = manifest.scripts?.test
  if (testScript?.split(/\s+/).includes('--isolate')) return undefined
  return `${file}: CHECK_LEGS marks ${JSON.stringify(leg.directory)} isolateTests; add --isolate to scripts.test`
}

function run(): number {
  const startedAt = performance.now()
  const isolatedLegs = CHECK_LEGS.filter(
    (leg): leg is typeof leg & IsolatedLeg => 'isolateTests' in leg && leg.isolateTests === true,
  )
  const violations = isolatedLegs.flatMap((leg) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, leg.directory, 'package.json'), 'utf8'))
    const violation = testIsolationViolation(leg, manifest)
    return violation ? [violation] : []
  })
  for (const violation of violations) console.error(violation)
  if (violations.length > 0) return 1
  console.log(
    `check-test-isolation: ok (${isolatedLegs.map((leg) => leg.directory).join(', ')}; ${(performance.now() - startedAt).toFixed(1)}ms)`,
  )
  return 0
}

if (import.meta.main) process.exit(run())
