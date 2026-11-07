import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { ratchetDecision } from '../shared/ratchet.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = [
  'orchestrator/src',
  'hub/src',
  'hub/data/src',
  'hub/deploy/site/src',
  'hub/site/src',
  'hub/ui/src',
  'hub/util/src',
  'hub/views/src',
  'retrieval/src',
  'cli/src',
  'shared',
  'scripts',
]
const PRIMITIVES = new Set([
  'shared/call-budgets.ts',
  'shared/bounded-process.ts',
  'shared/bounded-fetch.ts',
])
const GIT_HELPERS = new Set(['orchestrator/src/git/git-environment.ts', 'shared/git.ts'])
const TEST_INFRASTRUCTURE = new Set(['shared/test-git-repository.ts'])
const BASELINE_PATH = resolve(ROOT, 'scripts/quality/raw-start.json')
const RAW_REMEDY = 'use shared/bounded-process.ts or shared/bounded-fetch.ts with a named budget'
const GIT_ENV_REMEDY =
  'use the guarded helpers in orchestrator/src/git/git-environment.ts, or gitAt in shared/git.ts'

export type RawStart = {
  file: string
  line: number
  kind: 'process' | 'http'
  rawGit: boolean
  hasScrubbedEnvironment: boolean
}
export type RawStartBaseline = { files: Record<string, number> }

function productionTypeScript(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.d.ts') &&
    !path.startsWith('hub/web/') &&
    !PRIMITIVES.has(path) &&
    !TEST_INFRASTRUCTURE.has(path)
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
  return [...new Set(files)].filter(productionTypeScript).sort()
}

type Imports = {
  childCalls: Set<string>
  childNamespaces: Set<string>
  execaCalls: Set<string>
  execaNamespaces: Set<string>
  kyCalls: Set<string>
}

function importedStarts(file: ts.SourceFile): Imports {
  const imports: Imports = {
    childCalls: new Set(),
    childNamespaces: new Set(),
    execaCalls: new Set(),
    execaNamespaces: new Set(),
    kyCalls: new Set(),
  }
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const module = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (!clause) continue
    if (module === 'ky' && clause.name) imports.kyCalls.add(clause.name.text)
    const bindings = clause.namedBindings
    if (!bindings) continue
    if (ts.isNamespaceImport(bindings)) {
      if (module === 'node:child_process' || module === 'child_process')
        imports.childNamespaces.add(bindings.name.text)
      if (module === 'execa') imports.execaNamespaces.add(bindings.name.text)
      continue
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (
        (module === 'node:child_process' || module === 'child_process') &&
        ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].includes(
          imported,
        )
      )
        imports.childCalls.add(element.name.text)
      if (module === 'execa' && ['execa', 'execaSync', '$'].includes(imported))
        imports.execaCalls.add(element.name.text)
      if (module === 'ky' && imported === 'default') imports.kyCalls.add(element.name.text)
    }
  }
  return imports
}

function propertyCall(node: ts.CallExpression, owner: Set<string>): string | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined
  if (!ts.isIdentifier(node.expression.expression)) return undefined
  return owner.has(node.expression.expression.text) ? node.expression.name.text : undefined
}

function bunStart(node: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Bun' &&
    (node.expression.name.text === 'spawn' || node.expression.name.text === 'spawnSync')
  )
}

function globalFetch(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'fetch'
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'globalThis' &&
    node.expression.name.text === 'fetch'
  )
}

function kyStart(node: ts.CallExpression, imports: Imports): boolean {
  if (ts.isIdentifier(node.expression)) return imports.kyCalls.has(node.expression.text)
  const method = propertyCall(node, imports.kyCalls)
  return Boolean(method && ['get', 'post', 'put', 'patch', 'head', 'delete'].includes(method))
}

function gitFacts(node: ts.CallExpression, file: ts.SourceFile) {
  const argv = node.arguments[0]
  const command = argv && ts.isArrayLiteralExpression(argv) ? argv.elements[0] : undefined
  const rawGit = Boolean(command && ts.isStringLiteral(command) && command.text === 'git')
  const options = node.arguments[1]
  const env =
    options && ts.isObjectLiteralExpression(options)
      ? options.properties.find(
          (property) =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
            property.name.getText(file) === 'env',
        )
      : undefined
  const rawEnvironment =
    env && ts.isPropertyAssignment(env) && env.initializer.getText(file).includes('process.env')
  return { rawGit, hasScrubbedEnvironment: Boolean(env && !rawEnvironment) }
}

export function rawStarts(files: Readonly<Record<string, string>>): RawStart[] {
  const findings: RawStart[] = []
  for (const [path, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!productionTypeScript(path)) continue
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const imports = importedStarts(file)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const identifier = ts.isIdentifier(node.expression) ? node.expression.text : undefined
        const childProperty = propertyCall(node, imports.childNamespaces)
        const execaProperty = propertyCall(node, imports.execaNamespaces)
        const isProcess =
          bunStart(node) ||
          Boolean(
            identifier &&
              (imports.childCalls.has(identifier) || imports.execaCalls.has(identifier)),
          ) ||
          Boolean(
            childProperty &&
              [
                'spawn',
                'spawnSync',
                'exec',
                'execSync',
                'execFile',
                'execFileSync',
                'fork',
              ].includes(childProperty),
          ) ||
          Boolean(execaProperty && ['execa', 'execaSync', '$'].includes(execaProperty))
        const isHttp = globalFetch(node) || kyStart(node, imports)
        if (isProcess || isHttp) {
          const git = bunStart(node)
            ? gitFacts(node, file)
            : { rawGit: false, hasScrubbedEnvironment: false }
          findings.push({
            file: path,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            kind: isProcess ? 'process' : 'http',
            ...git,
          })
        }
      } else if (
        ts.isTaggedTemplateExpression(node) &&
        ts.isIdentifier(node.tag) &&
        imports.execaCalls.has(node.tag.text)
      ) {
        findings.push({
          file: path,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          kind: 'process',
          rawGit: false,
          hasScrubbedEnvironment: false,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return findings
}

function counts(findings: readonly RawStart[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const finding of findings) result[finding.file] = (result[finding.file] ?? 0) + 1
  return result
}

export function rawStartViolations(
  findings: readonly RawStart[],
  baseline: RawStartBaseline,
): string[] {
  const current = counts(findings)
  const baseFindings = Object.entries(baseline.files).map(([file, measure]) => ({
    file,
    line: 0,
    rule: 'raw-start',
    message: 'raw starts',
    measure,
  }))
  const headFindings = Object.entries(current).map(([file, measure]) => ({
    file,
    line: 0,
    rule: 'raw-start',
    message: 'raw starts',
    measure,
  }))
  const refused = ratchetDecision({
    base: baseFindings,
    head: headFindings,
    change: { renames: new Map(), addedLines: new Map() },
  })
  const violations = refused.flatMap((finding) => {
    const allowed = baseline.files[finding.file] ?? 0
    return findings
      .filter((candidate) => candidate.file === finding.file)
      .slice(allowed)
      .map(
        (candidate) =>
          `${candidate.file}:${candidate.line}: raw start is not bounded; ${RAW_REMEDY}`,
      )
  })
  for (const [file, allowed] of Object.entries(baseline.files)) {
    const actual = current[file] ?? 0
    if (actual < allowed)
      violations.push(
        `${file}: raw start baseline may only shrink; lower its count from ${allowed} to ${actual}`,
      )
  }
  return violations
}

export function gitEnvironmentViolations(findings: readonly RawStart[]): string[] {
  return findings
    .filter(
      (finding) =>
        finding.rawGit &&
        (finding.file.startsWith('orchestrator/src/') || finding.file.startsWith('shared/')) &&
        !GIT_HELPERS.has(finding.file) &&
        !finding.hasScrubbedEnvironment,
    )
    .map(
      (finding) =>
        `${finding.file}:${finding.line}: production git spawn must supply a scrubbed environment; ${GIT_ENV_REMEDY}`,
    )
}

export function baselineMatchesTree(
  findings: readonly RawStart[],
  baseline: RawStartBaseline,
): boolean {
  return JSON.stringify(counts(findings)) === JSON.stringify(baseline.files)
}

function checkRawStarts(
  files: Readonly<Record<string, string>>,
  baseline: RawStartBaseline,
  reporter: Pick<Console, 'error' | 'log'> = console,
): boolean {
  const findings = rawStarts(files)
  const violations = [
    ...gitEnvironmentViolations(findings),
    ...rawStartViolations(findings, baseline),
  ]
  for (const violation of violations) reporter.error(violation)
  if (violations.length) return false
  reporter.log(`check-raw-start: ok (${findings.length} frozen raw starts)`)
  return true
}

if (import.meta.main) {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as RawStartBaseline
  if (!checkRawStarts(files, baseline)) process.exit(1)
}
