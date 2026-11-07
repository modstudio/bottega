import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import * as ts from 'typescript'
import { ratchetDecision } from '../shared/ratchet.ts'
import { ARCHITECTURE_CRUISE_ENTRIES, typescriptCruiseEntries } from './architecture-cruise.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const PRIMITIVES = new Set([
  'shared/call-budgets.ts',
  'shared/bounded-process.ts',
  'shared/bounded-fetch.ts',
])
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
  bounded: boolean
}
export type RawStartBaseline = { files: Record<string, number> }

function productionTypeScript(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.d.ts') &&
    !path.includes('/test/') &&
    !path.startsWith('hub/web/src/') &&
    !PRIMITIVES.has(path)
  )
}

// Bun's Glob matches nothing when a brace alternative contains a slash.
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]+)\}/.exec(pattern)
  if (!match || match.index === undefined) return [pattern]
  const before = pattern.slice(0, match.index)
  const after = pattern.slice(match.index + match[0].length)
  return match[1]!.split(',').flatMap((choice) => expandBraces(`${before}${choice}${after}`))
}

function sourceFiles(): string[] {
  const files = typescriptCruiseEntries(ARCHITECTURE_CRUISE_ENTRIES).flatMap((entry) =>
    expandBraces(entry).flatMap((pattern) =>
      [...new Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })].filter(productionTypeScript),
    ),
  )
  return [...new Set(files)].sort()
}

type Imports = {
  boundedCalls: Set<string>
  boundedNamespaces: Set<string>
  childCalls: Set<string>
  childNamespaces: Set<string>
  execaCalls: Set<string>
  execaNamespaces: Set<string>
  kyCalls: Set<string>
}

const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process'])
const CHILD_PROCESS_CALLS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
])
const EXECA_CALLS = new Set(['execa', 'execaSync', '$'])
const KY_MODULE = 'ky'
const FETCH_CALL = 'fetch'
const BOUNDED_PROCESS_MODULE_NAME = 'bounded-process'
const BOUNDED_PROCESS_MODULE = new RegExp(`(^|/)${BOUNDED_PROCESS_MODULE_NAME}([.]ts)?$`)
const BOUNDED_PROCESS_CALLS = new Set([
  'startBounded',
  'startBoundedSync',
  'startBoundedSyncBytes',
])
const BUN_FORMS: readonly string[] = ['Bun.spawn', 'Bun.spawnSync', 'Bun.$']

/** The source pre-filter must name every detector's vocabulary. */
export const RAW_START_DETECTOR_TERMS = [
  ...CHILD_PROCESS_MODULES,
  ...EXECA_CALLS,
  KY_MODULE,
  FETCH_CALL,
  BOUNDED_PROCESS_MODULE_NAME,
  ...BOUNDED_PROCESS_CALLS,
  ...BUN_FORMS,
] as const

function registerNamespaceImport(imports: Imports, module: string, name: string): void {
  if (CHILD_PROCESS_MODULES.has(module)) imports.childNamespaces.add(name)
  if (module === 'execa') imports.execaNamespaces.add(name)
  if (BOUNDED_PROCESS_MODULE.test(module)) imports.boundedNamespaces.add(name)
}

function registerNamedImport(
  imports: Imports,
  module: string,
  imported: string,
  local: string,
): void {
  if (BOUNDED_PROCESS_MODULE.test(module) && BOUNDED_PROCESS_CALLS.has(imported))
    imports.boundedCalls.add(local)
  if (CHILD_PROCESS_MODULES.has(module) && CHILD_PROCESS_CALLS.has(imported))
    imports.childCalls.add(local)
  if (module === 'execa' && EXECA_CALLS.has(imported)) imports.execaCalls.add(local)
  if (module === KY_MODULE && imported === 'default') imports.kyCalls.add(local)
}

function registerStartImports(imports: Imports, statement: ts.ImportDeclaration): void {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return
  const module = statement.moduleSpecifier.text
  const clause = statement.importClause
  if (!clause) return
  if (module === KY_MODULE && clause.name) imports.kyCalls.add(clause.name.text)
  const bindings = clause.namedBindings
  if (!bindings) return
  if (ts.isNamespaceImport(bindings)) {
    registerNamespaceImport(imports, module, bindings.name.text)
    return
  }
  for (const element of bindings.elements) {
    registerNamedImport(
      imports,
      module,
      element.propertyName?.text ?? element.name.text,
      element.name.text,
    )
  }
}

function importedStarts(file: ts.SourceFile): Imports {
  const imports: Imports = {
    boundedCalls: new Set(),
    boundedNamespaces: new Set(),
    childCalls: new Set(),
    childNamespaces: new Set(),
    execaCalls: new Set(),
    execaNamespaces: new Set(),
    kyCalls: new Set(),
  }
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) registerStartImports(imports, statement)
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
    BUN_FORMS.includes(`Bun.${node.expression.name.text}`)
  )
}

function globalFetch(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) return node.expression.text === FETCH_CALL
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'globalThis' &&
    node.expression.name.text === FETCH_CALL
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

function processStart(node: ts.CallExpression, imports: Imports): boolean {
  const identifier = ts.isIdentifier(node.expression) ? node.expression.text : undefined
  const childProperty = propertyCall(node, imports.childNamespaces)
  const execaProperty = propertyCall(node, imports.execaNamespaces)
  return (
    bunStart(node) ||
    Boolean(
      identifier && (imports.childCalls.has(identifier) || imports.execaCalls.has(identifier)),
    ) ||
    Boolean(childProperty && CHILD_PROCESS_CALLS.has(childProperty)) ||
    Boolean(execaProperty && EXECA_CALLS.has(execaProperty))
  )
}

function boundedProcessStart(node: ts.CallExpression, imports: Imports): boolean {
  if (ts.isIdentifier(node.expression)) return imports.boundedCalls.has(node.expression.text)
  const method = propertyCall(node, imports.boundedNamespaces)
  return Boolean(method && BOUNDED_PROCESS_CALLS.has(method))
}

function callFinding(
  node: ts.CallExpression,
  file: ts.SourceFile,
  path: string,
  imports: Imports,
): RawStart | undefined {
  const isProcess = processStart(node, imports)
  const isBoundedProcess = boundedProcessStart(node, imports)
  if (!isProcess && !isBoundedProcess && !globalFetch(node) && !kyStart(node, imports))
    return undefined
  const git =
    bunStart(node) || isBoundedProcess
      ? gitFacts(node, file)
      : { rawGit: false, hasScrubbedEnvironment: false }
  return {
    file: path,
    line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    kind: isProcess || isBoundedProcess ? 'process' : 'http',
    bounded: isBoundedProcess,
    ...git,
  }
}

function taggedFinding(
  node: ts.TaggedTemplateExpression,
  file: ts.SourceFile,
  path: string,
  imports: Imports,
): RawStart | undefined {
  if (!ts.isIdentifier(node.tag) || !imports.execaCalls.has(node.tag.text)) return undefined
  return {
    file: path,
    line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
    kind: 'process',
    rawGit: false,
    hasScrubbedEnvironment: false,
    bounded: false,
  }
}

function startFinding(
  node: ts.Node,
  file: ts.SourceFile,
  path: string,
  imports: Imports,
): RawStart | undefined {
  if (ts.isCallExpression(node)) return callFinding(node, file, path, imports)
  if (ts.isTaggedTemplateExpression(node)) return taggedFinding(node, file, path, imports)
  return undefined
}

export function rawStarts(files: Readonly<Record<string, string>>): RawStart[] {
  const findings: RawStart[] = []
  for (const [path, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!productionTypeScript(path)) continue
    if (!RAW_START_DETECTOR_TERMS.some((term) => source.includes(term))) continue
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const imports = importedStarts(file)
    const visit = (node: ts.Node): void => {
      const finding = startFinding(node, file, path, imports)
      if (finding) findings.push(finding)
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return findings
}

function counts(findings: readonly RawStart[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const finding of findings) {
    if (finding.bounded || TEST_INFRASTRUCTURE.has(finding.file)) continue
    result[finding.file] = (result[finding.file] ?? 0) + 1
  }
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
      .filter((candidate) => candidate.file === finding.file && !candidate.bounded)
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
        !finding.hasScrubbedEnvironment,
    )
    .map(
      (finding) =>
        `${finding.file}:${finding.line}: production git spawn must supply a scrubbed environment; ${GIT_ENV_REMEDY}`,
    )
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
  const frozen = Object.values(counts(findings)).reduce((total, count) => total + count, 0)
  reporter.log(`check-raw-start: ok (${frozen} frozen raw starts)`)
  return true
}

if (import.meta.main) {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as RawStartBaseline
  if (!checkRawStarts(files, baseline)) process.exit(1)
}
