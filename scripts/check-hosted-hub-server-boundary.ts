#!/usr/bin/env bun
/** Enforce the hosted hub server concern boundary. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runArchitectureCruise } from './architecture-cruise.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const FILE = 'hub/src/hosted.ts'
const SPAWN_PATTERN = /\bBun\.spawn(?:Sync)?\s*\(/

type CruiseModule = {
  source: string
  coreModule?: boolean
  matchesDoNotFollow?: boolean
}

function cruiseModules(stdout: string): CruiseModule[] {
  const result: unknown = JSON.parse(stdout)
  if (
    typeof result !== 'object' ||
    result === null ||
    !('modules' in result) ||
    !Array.isArray(result.modules)
  ) {
    throw new Error('dependency-cruiser JSON has no modules array')
  }
  return result.modules.filter(
    (module): module is CruiseModule =>
      typeof module === 'object' &&
      module !== null &&
      'source' in module &&
      typeof module.source === 'string',
  )
}

const { exitCode, stdout } = await runArchitectureCruise({
  entries: [FILE],
  extraArgs: ['--output-type', 'json'],
  stdout: 'pipe',
})
if (exitCode !== 0) process.exit(exitCode)

const violations: string[] = []
for (const module of cruiseModules(stdout)) {
  if (module.coreModule || module.matchesDoNotFollow) continue
  const absolute = join(ROOT, module.source)
  if (!existsSync(absolute)) continue
  if (SPAWN_PATTERN.test(readFileSync(absolute, 'utf8'))) {
    violations.push(`${module.source} calls Bun.spawn`)
  }
}

if (violations.length) {
  console.error(`check-hosted-hub-server-boundary: ${violations.length} violation(s)\n`)
  for (const violation of violations) console.error(`  ${violation}\n`)
  process.exit(1)
}
console.log('check-hosted-hub-server-boundary: ok')
