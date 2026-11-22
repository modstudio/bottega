import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const started = performance.now()
const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoots = ['scripts', 'orchestrator/src', 'shared', 'hub', 'cli', 'retrieval']
const runTreeCleanHelper = 'orchestrator/src/worktree/worktree-attribution.ts'
const remedy = 'run git clean only through cleanRunTree so the run ownership marker is preserved'

type GitCleanLiteral = { file: string; line: number }
export type GitCleanSiteScan = {
  findings: GitCleanLiteral[]
  filesScanned: number
  exemptSites: number
}

function productionTypeScript(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts')
}

function sourceFiles(): string[] {
  const files: string[] = []
  const collect = (directory: string) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') collect(absolute)
      } else if (entry.isFile()) files.push(relative(root, absolute))
    }
  }
  for (const directory of sourceRoots) collect(join(root, directory))
  return files.filter(productionTypeScript).sort()
}

function insideCleanRunTree(node: ts.Node, path: string): boolean {
  if (path !== runTreeCleanHelper) return false
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current)) return current.name?.text === 'cleanRunTree'
  }
  return false
}

function isGitCleanArray(node: ts.ArrayLiteralExpression): boolean {
  return node.elements.some((element, index) => {
    if (!ts.isStringLiteral(element) || element.text !== 'clean') return false
    if (index === 0) return true
    return node.elements
      .slice(0, index)
      .some((earlier) => ts.isStringLiteral(earlier) && earlier.text === 'git')
  })
}

/** Find git-clean argument arrays outside the marker-preserving worktree helper. */
export function scanGitCleanSites(files: Readonly<Record<string, string>>): GitCleanSiteScan {
  const findings: GitCleanLiteral[] = []
  let filesScanned = 0
  let exemptSites = 0
  for (const [path, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!productionTypeScript(path)) continue
    filesScanned++
    if (!source.includes("'clean'") && !source.includes('"clean"')) continue
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isArrayLiteralExpression(node) && isGitCleanArray(node)) {
        if (insideCleanRunTree(node, path)) exemptSites++
        else {
          findings.push({
            file: path,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return { findings, filesScanned, exemptSites }
}

export function checkGitCleanSites(
  files: Readonly<Record<string, string>>,
  reporter: Pick<Console, 'error' | 'log'> = console,
): boolean {
  const scan = scanGitCleanSites(files)
  for (const finding of scan.findings) {
    reporter.error(`${finding.file}:${finding.line}: raw git clean; ${remedy}`)
  }
  if (scan.findings.length) return false
  reporter.log(
    `git clean-site scan: ${scan.filesScanned} files scanned, ${scan.exemptSites} exempt cleanRunTree sites (${(performance.now() - started).toFixed(1)}ms)`,
  )
  return true
}

if (import.meta.main) {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  )
  if (!checkGitCleanSites(files)) process.exit(1)
}
