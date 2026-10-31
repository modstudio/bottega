import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['scripts', 'orchestrator/src', 'shared', 'hub/src', 'cli']
const EXCLUDED_HELPER = 'shared/git-path-list.ts'
const BASELINE_PATH = resolve(ROOT, 'scripts/quality/git-path-list.json')
const PATH_LIST_ARGUMENTS = new Set('--name-only,--name-status,ls-files,diff-tree'.split(','))
const REMEDY =
  'build the arguments with nulPathListArgs and parse with splitNulPaths or splitNulNameStatus from shared/git-path-list.ts'

export type GitPathListLiteral = { file: string; line: number }
type GitPathListBaseline = { files: Record<string, number> }

function productionTypeScript(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts')
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

/** Only a file quoting a path-list argument can hold a finding, so the rest skip parsing. */
function mentionsPathList(source: string): boolean {
  for (const argument of PATH_LIST_ARGUMENTS) {
    if (source.includes(`'${argument}'`) || source.includes(`"${argument}"`)) return true
  }
  return false
}

function guardedArray(node: ts.ArrayLiteralExpression): boolean {
  const parent = node.parent
  return (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === node &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === 'nulPathListArgs'
  )
}

/** Find Git path-list argument arrays without reading the repository tree. */
export function gitPathListLiterals(files: Readonly<Record<string, string>>): GitPathListLiteral[] {
  const findings: GitPathListLiteral[] = []
  for (const [path, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!productionTypeScript(path) || path === EXCLUDED_HELPER || !mentionsPathList(source))
      continue
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (
        ts.isArrayLiteralExpression(node) &&
        !guardedArray(node) &&
        node.elements.some(
          (element) => ts.isStringLiteral(element) && PATH_LIST_ARGUMENTS.has(element.text),
        )
      ) {
        findings.push({
          file: path,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return findings
}

export function gitPathListViolations(
  findings: readonly GitPathListLiteral[],
  baseline: GitPathListBaseline,
): string[] {
  const byFile = new Map<string, GitPathListLiteral[]>()
  for (const finding of findings) {
    const rows = byFile.get(finding.file) ?? []
    rows.push(finding)
    byFile.set(finding.file, rows)
  }
  const violations: string[] = []
  for (const [file, rows] of byFile) {
    const allowed = baseline.files[file] ?? 0
    for (const finding of rows.slice(allowed)) {
      violations.push(`${finding.file}:${finding.line}: raw git path list; ${REMEDY}`)
    }
  }
  for (const [file, allowed] of Object.entries(baseline.files)) {
    const current = byFile.get(file)?.length ?? 0
    if (current < allowed) {
      violations.push(
        `${file}: git path-list baseline may only shrink; lower its count from ${allowed} to ${current}`,
      )
    }
  }
  return violations
}

function checkGitPathLists(
  files: Readonly<Record<string, string>>,
  baseline: GitPathListBaseline,
  reporter: Pick<Console, 'error' | 'log'> = console,
): boolean {
  const findings = gitPathListLiterals(files)
  const violations = gitPathListViolations(findings, baseline)
  for (const violation of violations) reporter.error(violation)
  if (violations.length) return false
  reporter.log(`check-git-path-list: ok (${findings.length} frozen raw path lists)`)
  return true
}

if (import.meta.main) {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as GitPathListBaseline
  if (!checkGitPathLists(files, baseline)) process.exit(1)
}
