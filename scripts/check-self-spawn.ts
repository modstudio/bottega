/**
 * Reject direct launches of repository Bottega entries. Values imported from other modules are
 * intentionally not followed; an imported value is the accepted limit of this static check.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { PLATFORM_NAME } from '../shared/brand.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const resolver = join(root, 'shared', 'self-spawn.ts')

export type TaskVerbSpawn = { line: number; verb: string; exemptFreshRead: boolean }

export const TASK_WRITE_BASELINE = {
  'orchestrator/src/issue/issue-dispatch.ts': {
    count: 4,
    reason: 'task write, later slice',
  },
  'orchestrator/src/issue/issue.ts': { count: 4, reason: 'task write, later slice' },
  'orchestrator/src/workflow/workflow-text-copy.ts': {
    count: 1,
    reason: 'task write, later slice',
  },
} as const

type Binding =
  | ts.VariableDeclaration
  | ts.ParameterDeclaration
  | ts.ImportSpecifier
  | ts.NamespaceImport
type Scope = ts.SourceFile | ts.Block | ts.SignatureDeclaration

function isScope(node: ts.Node): node is Scope {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)
}

function declarationScope(node: Binding): Scope | undefined {
  if (ts.isParameter(node)) return ts.isFunctionLike(node.parent) ? node.parent : undefined
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isScope(current)) return current
    current = current.parent
  }
  return undefined
}

function childProcessImport(node: ts.ImportDeclaration): boolean {
  return (
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:child_process'
  )
}

const SPAWN_METHODS = ['spawn', 'spawnSync', 'execFile', 'execFileSync']

function gatherChildProcessBindings(
  node: ts.Node,
  source: ts.SourceFile,
  bind: (scope: Scope, name: string, declaration: Binding) => void,
  childProcessFunctions: Set<Binding>,
  childProcessNamespaces: Set<ts.NamespaceImport>,
): void {
  if (!ts.isImportDeclaration(node) || !childProcessImport(node)) return
  const imports = node.importClause?.namedBindings
  if (imports && ts.isNamedImports(imports)) {
    for (const element of imports.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (!SPAWN_METHODS.includes(imported)) continue
      bind(source, element.name.text, element)
      childProcessFunctions.add(element)
    }
  } else if (imports && ts.isNamespaceImport(imports)) {
    bind(source, imports.name.text, imports)
    childProcessNamespaces.add(imports)
  }
}

function sourceEntryText(text: string): boolean {
  const sourceEntry = /(?:orchestrator|hub|retrieval)[/'"`,)\s]+src[\s\S]*?\.ts\b/.test(text)
  const binWrapper = /bin[/'"`,)\s]+(?:orch|hub|retrieval-search)\b/.test(text)
  return sourceEntry || binWrapper
}

/** Return one-based lines containing direct Bottega self-spawns in a TypeScript source. */
export function selfSpawnViolationLines(sourceText: string, path = 'fixture.ts'): number[] {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const bindings = new Map<Scope, Map<string, Binding>>()
  const childProcessFunctions = new Set<Binding>()
  const childProcessNamespaces = new Set<ts.NamespaceImport>()

  const bind = (scope: Scope, name: string, declaration: Binding): void => {
    const names = bindings.get(scope) ?? new Map<string, Binding>()
    names.set(name, declaration)
    bindings.set(scope, names)
  }

  const gather = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      const scope = declarationScope(node)
      if (scope) bind(scope, node.name.text, node)
    }
    gatherChildProcessBindings(node, source, bind, childProcessFunctions, childProcessNamespaces)
    ts.forEachChild(node, gather)
  }
  gather(source)

  const bindingFor = (identifier: ts.Identifier): Binding | undefined => {
    let current: ts.Node | undefined = identifier.parent
    while (current) {
      if (isScope(current)) {
        const binding = bindings.get(current)?.get(identifier.text)
        if (binding) return binding
      }
      current = current.parent
    }
    return undefined
  }

  const initializer = (binding: Binding): ts.Expression | undefined =>
    ts.isVariableDeclaration(binding) || ts.isParameter(binding) ? binding.initializer : undefined

  const resolve = (expression: ts.Expression, seen = new Set<Binding>()): ts.Expression => {
    if (!ts.isIdentifier(expression)) return expression
    const binding = bindingFor(expression)
    if (!binding || seen.has(binding)) return expression
    const value = initializer(binding)
    if (!value) return expression
    seen.add(binding)
    return resolve(value, seen)
  }

  const expressionText = (
    expression: ts.Expression | undefined,
    seen = new Set<Binding>(),
  ): string => {
    if (!expression) return ''
    if (ts.isIdentifier(expression)) {
      const binding = bindingFor(expression)
      if (binding && !seen.has(binding)) {
        const value = initializer(binding)
        if (value) return `${expression.text} ${expressionText(value, new Set(seen).add(binding))}`
      }
      return expression.text
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements
        .map((element) =>
          ts.isSpreadElement(element)
            ? expressionText(element.expression, seen)
            : expressionText(element as ts.Expression, seen),
        )
        .join(' ')
    }
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
      return `${expression.expression.getText(source)} ${expression.arguments
        ?.map((argument) => expressionText(argument, seen))
        .join(' ')}`
    }
    if (ts.isParenthesizedExpression(expression)) return expressionText(expression.expression, seen)
    return expression.getText(source)
  }

  const resolverCall = (expression: ts.Expression): boolean => {
    const value = resolve(expression)
    return (
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === 'bottegaEntryArgv'
    )
  }

  const startsWithResolverSpread = (expression: ts.Expression | undefined): boolean => {
    if (!expression) return false
    const value = resolve(expression)
    if (!ts.isArrayLiteralExpression(value)) return false
    const first = value.elements[0]
    if (!first || !ts.isSpreadElement(first)) return false
    if (resolverCall(first.expression)) return true
    return startsWithResolverSpread(first.expression)
  }

  type SpawnKind = 'bun' | 'node'
  const spawnKind = (call: ts.CallExpression): SpawnKind | undefined => {
    const expression = call.expression
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'Bun' &&
      (expression.name.text === 'spawn' || expression.name.text === 'spawnSync')
    ) {
      return 'bun'
    }
    if (ts.isIdentifier(expression)) {
      const binding = bindingFor(expression)
      if (binding && childProcessFunctions.has(binding)) return 'node'
    }
    if (
      ts.isPropertyAccessExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      SPAWN_METHODS.includes(expression.name.text)
    ) {
      const binding = bindingFor(expression.expression)
      if (binding && ts.isNamespaceImport(binding) && childProcessNamespaces.has(binding)) {
        return 'node'
      }
    }
    return undefined
  }

  const violations: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = spawnKind(node)
      if (kind) {
        const command = node.arguments[0]
        const argvText =
          kind === 'bun'
            ? expressionText(command)
            : `${expressionText(command)} ${expressionText(node.arguments[1])}`
        if (sourceEntryText(argvText) && !startsWithResolverSpread(command)) {
          violations.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function containingFunctionName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    )
      return current.parent.name.text
  }
  return undefined
}

function taskTokens(expression: ts.Expression | undefined): string[] {
  if (!expression || !ts.isArrayLiteralExpression(expression)) return []
  return expression.elements.flatMap((element) => {
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element))
      return [element.text]
    return []
  })
}

/** Find calls that send the task verb group to an orchestrator self-spawn helper. */
export function taskVerbSpawns(sourceText: string, path = 'fixture.ts'): TaskVerbSpawn[] {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const findings: TaskVerbSpawn[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      const spawnCall = ['startBounded', 'startBoundedSync', 'spawnBottega', 'hub'].includes(callee)
      if (spawnCall) {
        const tokens = taskTokens(node.arguments[0])
        const task = tokens.indexOf('task')
        const verb = task < 0 ? undefined : tokens[task + 1]
        if (verb) {
          findings.push({
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            verb,
            exemptFreshRead:
              containingFunctionName(node) === 'readFreshHubTaskThroughCli' && verb === 'show',
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

export function taskVerbSpawnViolations(
  path: string,
  findings: readonly TaskVerbSpawn[],
): string[] {
  const reads = findings.filter(
    (finding) => (finding.verb === 'show' || finding.verb === 'list') && !finding.exemptFreshRead,
  )
  const writes = findings.filter((finding) => finding.verb !== 'show' && finding.verb !== 'list')
  const baseline = TASK_WRITE_BASELINE[path as keyof typeof TASK_WRITE_BASELINE]
  const allowedWrites = baseline?.count ?? 0
  const violations = reads.map(
    ({ line, verb }) => `${path}:${line}: task ${verb} must use the installed task reader`,
  )
  if (writes.length > allowedWrites) {
    for (const { line, verb } of writes.slice(allowedWrites))
      violations.push(`${path}:${line}: task ${verb} is not in the task-write baseline`)
  }
  if (writes.length < allowedWrites) {
    violations.push(
      `${path}: task-write baseline may only shrink; lower its count from ${allowedWrites} to ${writes.length}`,
    )
  }
  return violations
}

function collect(directory: string, files: string[]): void {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path, files)
    else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.fixtures.ts') &&
      path !== resolver
    ) {
      files.push(path)
    }
  }
}

if (import.meta.main) {
  const files: string[] = []
  for (const directory of ['orchestrator/src', 'hub/src', 'retrieval/src', 'shared']) {
    collect(join(root, directory), files)
  }
  const violations = files.flatMap((path) =>
    selfSpawnViolationLines(readFileSync(path, 'utf8'), path).map(
      (line) => `${relative(root, path)}:${line}`,
    ),
  )
  for (const violation of violations) {
    console.error(`${violation}: launch ${PLATFORM_NAME} entries through shared/self-spawn.ts`)
  }
  const taskViolations = files.flatMap((path) => {
    if (!path.startsWith(join(root, 'orchestrator', 'src'))) return []
    const relativePath = relative(root, path)
    return taskVerbSpawnViolations(
      relativePath,
      taskVerbSpawns(readFileSync(path, 'utf8'), relativePath),
    )
  })
  for (const violation of taskViolations) console.error(violation)
  if (violations.length || taskViolations.length) process.exit(1)
}
