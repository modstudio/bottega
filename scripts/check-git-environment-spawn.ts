import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['orchestrator/src', 'hub/src', 'shared']
const EXCLUDED_HELPERS = new Set(['orchestrator/src/git/git-environment.ts', 'shared/git.ts'])
// This module provisions repositories only for tests, despite not carrying a test filename suffix.
const EXCLUDED_TEST_INFRASTRUCTURE = new Set(['shared/test-git-repository.ts'])
const BASELINE_PATH = resolve(ROOT, 'scripts/quality/raw-git-spawn.json')
const REMEDY =
  'use the guarded helpers in orchestrator/src/git/git-environment.ts, or gitAt in shared/git.ts'

export type GitSpawn = {
  file: string
  line: number
  hasScrubbedEnvironment: boolean
  countsTowardBaseline: boolean
}
type RawGitSpawnBaseline = { files: Record<string, number> }

function productionTypeScript(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts')
}

function countedRawSpawn(path: string): boolean {
  return (
    productionTypeScript(path) &&
    !EXCLUDED_HELPERS.has(path) &&
    !EXCLUDED_TEST_INFRASTRUCTURE.has(path)
  )
}

function sourceFiles(): string[] {
  const files: string[] = []
  const collect = (directory: string) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) collect(absolute)
      else if (entry.isFile()) files.push(relative(ROOT, absolute))
    }
  }
  for (const directory of SOURCE_ROOTS) collect(resolve(ROOT, directory))
  return files.filter(productionTypeScript).sort()
}

/** Find direct Bun git process calls without reading the repository tree. */
export function gitSpawns(files: Readonly<Record<string, string>>): GitSpawn[] {
  const findings: GitSpawn[] = []
  for (const [path, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!productionTypeScript(path) || !source.includes('Bun.spawn') || !source.includes("'git'"))
      continue
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
          const options = node.arguments[1]
          const env =
            options && ts.isObjectLiteralExpression(options)
              ? options.properties.find(
                  (property) =>
                    (ts.isPropertyAssignment(property) ||
                      ts.isShorthandPropertyAssignment(property)) &&
                    property.name.getText(file) === 'env',
                )
              : undefined
          const raw =
            env &&
            ts.isPropertyAssignment(env) &&
            env.initializer.getText(file).includes('process.env')
          findings.push({
            file: path,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            hasScrubbedEnvironment: Boolean(env && !raw),
            countsTowardBaseline: countedRawSpawn(path),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return findings
}

// A spawn whose argv is held in a variable, or built at runtime, is not detected.

export function rawGitSpawnViolations(
  findings: readonly GitSpawn[],
  baseline: RawGitSpawnBaseline,
): string[] {
  const byFile = new Map<string, GitSpawn[]>()
  for (const finding of findings) {
    if (!finding.countsTowardBaseline) continue
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

export function gitEnvironmentViolations(findings: readonly GitSpawn[]): string[] {
  return findings
    .filter(
      (finding) =>
        (finding.file.startsWith('orchestrator/src/') || finding.file.startsWith('shared/')) &&
        !finding.hasScrubbedEnvironment,
    )
    .map(
      (finding) =>
        `${finding.file}:${finding.line}: production git spawn must supply a scrubbed environment`,
    )
}

function checkGitSpawns(
  files: Readonly<Record<string, string>>,
  baseline: RawGitSpawnBaseline,
  reporter: Pick<Console, 'error' | 'log'> = console,
): boolean {
  const findings = gitSpawns(files)
  const violations = [
    ...gitEnvironmentViolations(findings),
    ...rawGitSpawnViolations(findings, baseline),
  ]
  for (const violation of violations) reporter.error(violation)
  if (violations.length) return false
  reporter.log(
    `check-git-environment-spawn: ok (${findings.filter((finding) => finding.countsTowardBaseline).length} frozen raw spawns)`,
  )
  return true
}

if (import.meta.main) {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as RawGitSpawnBaseline
  if (!checkGitSpawns(files, baseline)) process.exit(1)
}
