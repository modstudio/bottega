#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['orchestrator/src', 'hub/src', 'shared']
const EXCLUDED_HELPERS = new Set(['orchestrator/src/git/git-environment.ts', 'shared/git.ts'])
// This module provisions repositories only for tests, despite not carrying a test filename suffix.
const EXCLUDED_TEST_INFRASTRUCTURE = new Set(['shared/test-git-repository.ts'])
const BASELINE_PATH = resolve(ROOT, 'scripts/quality/raw-git-spawn.json')
const REMEDY =
  'use the guarded helpers in orchestrator/src/git/git-environment.ts, or gitAt in shared/git.ts'

export type RawGitSpawn = { file: string; line: number }
type RawGitSpawnBaseline = { files: Record<string, number> }

function productionTypeScript(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.fixture.ts') &&
    !path.split('/').includes('fixtures') &&
    !EXCLUDED_HELPERS.has(path) &&
    !EXCLUDED_TEST_INFRASTRUCTURE.has(path)
  )
}

function sourceFiles(): string[] {
  const files: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(relative(ROOT, absolute))
    }
  }
  for (const directory of SOURCE_ROOTS) visit(resolve(ROOT, directory))
  return files.filter(productionTypeScript).sort()
}

/** Find direct Bun git process calls without reading the repository tree. */
export function rawGitSpawns(files: Readonly<Record<string, string>>): RawGitSpawn[] {
  const findings: RawGitSpawn[] = []
  for (const [path, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!productionTypeScript(path)) continue
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Bun' &&
        (node.expression.name.text === 'spawn' || node.expression.name.text === 'spawnSync')
      ) {
        const argv = node.arguments[0]
        const command = argv && ts.isArrayLiteralExpression(argv) ? argv.elements[0] : undefined
        if (command && ts.isStringLiteral(command) && command.text === 'git') {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
          findings.push({ file: path, line })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return findings
}

export function rawGitSpawnViolations(
  findings: readonly RawGitSpawn[],
  baseline: RawGitSpawnBaseline,
): string[] {
  const byFile = new Map<string, RawGitSpawn[]>()
  for (const finding of findings) {
    const rows = byFile.get(finding.file) ?? []
    rows.push(finding)
    byFile.set(finding.file, rows)
  }
  const violations: string[] = []
  for (const [file, rows] of byFile) {
    const allowed = baseline.files[file] ?? 0
    for (const finding of rows.slice(allowed)) {
      violations.push(`${finding.file}:${finding.line}: raw git spawn is not guarded; ${REMEDY}`)
    }
  }
  for (const [file, allowed] of Object.entries(baseline.files)) {
    const current = byFile.get(file)?.length ?? 0
    if (current < allowed) {
      violations.push(
        `${file}: raw git spawn baseline may only shrink; lower its count from ${allowed} to ${current}`,
      )
    }
  }
  return violations
}

function checkRawGitSpawn(
  files: Readonly<Record<string, string>>,
  baseline: RawGitSpawnBaseline,
  reporter: Pick<Console, 'error' | 'log'> = console,
): boolean {
  const findings = rawGitSpawns(files)
  const violations = rawGitSpawnViolations(findings, baseline)
  for (const violation of violations) reporter.error(violation)
  if (violations.length) return false
  reporter.log(`check-raw-git-spawn: ok (${findings.length} frozen raw spawns)`)
  return true
}

if (import.meta.main) {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as RawGitSpawnBaseline
  if (!checkRawGitSpawn(files, baseline)) process.exit(1)
}
