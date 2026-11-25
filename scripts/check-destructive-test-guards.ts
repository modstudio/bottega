import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const DIRECTORIES = ['shared', 'hub/test', 'orchestrator/test'] as const
const ENVIRONMENT_RETURN = /if\s*\(\s*!?process\.env\.[A-Za-z_$][\w$]*[^)\n]*\)\s*return\b/
const REMEDY =
  'a test-store guard must refuse by store identity, never by environment, and a production opener decides in its own caller when the test question applies'

function guardedTestInfrastructure(path: string): boolean {
  if (path.endsWith('.test.ts')) return false
  return (
    /^shared\/test-[^/]+\.ts$/.test(path) ||
    /^hub\/test\/[^/]+\.ts$/.test(path) ||
    /^orchestrator\/test\/[^/]+\.ts$/.test(path) ||
    path === 'scripts/test-preload.ts'
  )
}

function sourcePaths(): string[] {
  const paths = DIRECTORIES.flatMap((directory) => {
    const absolute = join(ROOT, directory)
    if (!existsSync(absolute)) return []
    return readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(ROOT, join(absolute, entry.name)))
  })
  paths.push('scripts/test-preload.ts')
  return paths.filter(guardedTestInfrastructure).sort()
}

type DestructiveTestGuardFinding = { file: string; line: number }

/** Find test-store guards whose refusal can be disabled by an environment variable. */
function destructiveTestGuardFindings(
  files: Readonly<Record<string, string>>,
): DestructiveTestGuardFinding[] {
  return Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([file, source]) =>
      source
        .split('\n')
        .flatMap((line, index) =>
          ENVIRONMENT_RETURN.test(line) ? [{ file, line: index + 1 }] : [],
        ),
    )
}

if (import.meta.main) {
  const files = Object.fromEntries(
    sourcePaths().map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]),
  )
  const findings = destructiveTestGuardFindings(files)
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${REMEDY}`)
  console.log(findings.length)
  if (findings.length > 0) process.exit(1)
}
