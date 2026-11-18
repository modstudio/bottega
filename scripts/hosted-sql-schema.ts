import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'

export type HostedSqlSite = {
  file: string
  line: number
  sql: string
  fingerprint: string
}

export type HostedSqlUnresolvedSite = HostedSqlSite & { expression: string }

type RenderedSql = { sql: string; bindings: number }
type StaticValue = string | string[]
type StaticSymbols = {
  constants: Map<string, ts.Expression>
  functions: Map<string, ts.FunctionDeclaration>
}
const HOSTED_SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i
const LOCAL_HANDLE_SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|DROP|ALTER)\b/i

function hostedSqlFingerprint(sql: string): string {
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

export function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path)
  }
  return files
}

function importedFixturePath(root: string, file: string, statement: ts.Statement): string | null {
  const moduleSpecifier =
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier
  if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return null
  const specifier = moduleSpecifier.text
  if (!specifier.startsWith('.')) return null
  const imported = resolve(dirname(file), specifier)
  const candidate = imported.endsWith('.ts') ? imported : `${imported}.ts`
  return candidate.startsWith(resolve(root, 'orchestrator/test/')) ? candidate : null
}

function hostedFixtureTypeScriptFiles(root: string): string[] {
  const postgresDirectory = resolve(root, 'orchestrator/src/postgres')
  const entrypoints = productionTypeScriptFilesIncludingTests(postgresDirectory).filter((file) => {
    const name = file.slice(file.lastIndexOf('/') + 1)
    return name.startsWith('postgres-') && name.endsWith('.test.ts')
  })
  const files = new Set(entrypoints)
  const pending = [...entrypoints]
  while (pending.length) {
    const file = pending.pop()!
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    for (const statement of source.statements) {
      const candidate = importedFixturePath(root, file, statement)
      if (!candidate || files.has(candidate)) continue
      files.add(candidate)
      pending.push(candidate)
    }
  }
  return [...files].sort()
}

function productionTypeScriptFilesIncludingTests(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...productionTypeScriptFilesIncludingTests(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

const HOSTED_FIXTURE_IMPORTS_WITHOUT_SQL = new Set([
  'orchestrator/src/postgres/postgres-migrate-public-role.test.ts',
  'orchestrator/src/postgres/postgres-migrate-schema.test.ts',
  // Builds hosted document-import HTTP payloads and intentionally owns no SQL.
  'orchestrator/test/fixtures/doc-import.ts',
  'orchestrator/test/fixtures/record-api.ts',
  'orchestrator/test/fixtures/record-api-question.ts',
  // Serves an in-memory hosted task-flow store and intentionally owns no SQL.
  'orchestrator/test/fixtures/record-api-task-flow.ts',
  'orchestrator/test/fixtures/record-session.ts',
  // Drives machine-key registration through its service and intentionally owns no SQL.
  'orchestrator/test/support/machine-signing-registration-proof.ts',
  // Records gate fixture timings and intentionally owns no SQL.
  'orchestrator/test/gate-phase-timing.ts',
  'orchestrator/test/gate-timings-reporter.ts',
  'orchestrator/test/preload.ts',
  // Registers hosted canon HTTP assertions and intentionally owns no SQL.
  'orchestrator/test/canon-import-proof.ts',
  'orchestrator/test/postgres-board-api-values.ts',
  'orchestrator/test/postgres-board-cache-client.ts',
  // Drives the receipt and change-feed routes over HTTP and owns no SQL.
  'orchestrator/test/postgres-board-receipt-revision-proof.ts',
  'orchestrator/test/postgres-board-route-edge-proof.ts',
  'orchestrator/test/postgres-board-reply-proof.ts',
  'orchestrator/test/postgres-board-thread-expiry-proof.ts',
  'orchestrator/test/postgres-board-shared-space-api-proof.ts',
  'orchestrator/test/postgres-canon-refusal-proof.ts',
  'orchestrator/test/postgres-customer-auth-proof.ts',
  'orchestrator/test/postgres-doc-order-proof.ts',
  'orchestrator/test/postgres-project-identity-proof.ts',
  // Logs slow hosted proof requests and intentionally owns no SQL.
  'orchestrator/test/postgres-proof-slow-request.ts',
  'orchestrator/test/postgres-rls-values.ts',
  // Drives the hosted task-flow read routes through the client and owns no SQL.
  'orchestrator/test/postgres-task-flow-read-proof.ts',
])

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  )
    return unwrap(node.expression)
  return node
}

function isSqlTag(node: ts.Expression): boolean {
  const tag = unwrap(node)
  return ts.isIdentifier(tag) && (tag.text === 'sql' || tag.text === 'tx')
}

function importsBunSql(source: ts.SourceFile): boolean {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === 'bun' &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (item) => (item.propertyName?.text ?? item.name.text) === 'SQL',
      ),
  )
}

function shiftBindings(sql: string, offset: number): string {
  return sql.replace(/\$(\d+)/g, (_, number: string) => `$${Number(number) + offset}`)
}

function functionReturnExpression(node: ts.ConciseBody): ts.Expression | null {
  if (!ts.isBlock(node)) return node
  const returned = node.statements.find(ts.isReturnStatement)
  return returned?.expression ?? null
}

function resolveStaticArray(
  node: ts.ArrayLiteralExpression,
  symbols: StaticSymbols,
  bindings: Map<string, StaticValue>,
  seen: Set<string>,
): string[] | null {
  const values = node.elements.map((item) =>
    ts.isSpreadElement(item) ? null : resolveStaticValue(item, symbols, bindings, seen),
  )
  return values.every((value): value is string => typeof value === 'string') ? values : null
}

function resolveStaticTemplate(
  node: ts.TemplateExpression,
  symbols: StaticSymbols,
  bindings: Map<string, StaticValue>,
  seen: Set<string>,
): string | null {
  let value = node.head.text
  for (const span of node.templateSpans) {
    const resolved = resolveStaticValue(span.expression, symbols, bindings, seen)
    if (typeof resolved !== 'string') return null
    value += resolved + span.literal.text
  }
  return value
}

function resolveStaticIdentifier(
  node: ts.Identifier,
  symbols: StaticSymbols,
  bindings: Map<string, StaticValue>,
  seen: Set<string>,
): StaticValue | null {
  const bound = bindings.get(node.text)
  if (bound !== undefined) return bound
  if (seen.has(node.text)) return null
  const initializer = symbols.constants.get(node.text)
  return initializer
    ? resolveStaticValue(initializer, symbols, bindings, new Set([...seen, node.text]))
    : null
}

function resolveStaticFunctionCall(
  node: ts.CallExpression,
  target: ts.Identifier,
  symbols: StaticSymbols,
  bindings: Map<string, StaticValue>,
  seen: Set<string>,
): StaticValue | null {
  if (seen.has(target.text)) return null
  const declaration = symbols.functions.get(target.text)
  const returned = declaration?.body && functionReturnExpression(declaration.body)
  if (!declaration || !returned) return null
  const nextBindings = new Map(bindings)
  for (const [index, parameter] of declaration.parameters.entries()) {
    const argument = node.arguments[index]
    if (!ts.isIdentifier(parameter.name) || !argument) return null
    const value = resolveStaticValue(argument, symbols, bindings, seen)
    if (value === null) return null
    nextBindings.set(parameter.name.text, value)
  }
  return resolveStaticValue(returned, symbols, nextBindings, new Set([...seen, target.text]))
}

function resolveStaticMapCall(
  node: ts.CallExpression,
  receiver: string[],
  symbols: StaticSymbols,
  bindings: Map<string, StaticValue>,
  seen: Set<string>,
): string[] | null {
  const callback = node.arguments[0]
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)))
    return null
  const parameter = callback.parameters[0]
  const returned = functionReturnExpression(callback.body)
  if (!parameter || !ts.isIdentifier(parameter.name) || !returned) return null
  const parameterName = parameter.name.text
  const values = receiver.map((item) => {
    const nextBindings = new Map(bindings)
    nextBindings.set(parameterName, item)
    return resolveStaticValue(returned, symbols, nextBindings, seen)
  })
  return values.every((value): value is string => typeof value === 'string') ? values : null
}

function resolveStaticPropertyCall(
  node: ts.CallExpression,
  target: ts.PropertyAccessExpression,
  symbols: StaticSymbols,
  bindings: Map<string, StaticValue>,
  seen: Set<string>,
): StaticValue | null {
  const receiver = resolveStaticValue(target.expression, symbols, bindings, seen)
  if (!Array.isArray(receiver)) return null
  if (target.name.text === 'map')
    return resolveStaticMapCall(node, receiver, symbols, bindings, seen)
  if (target.name.text !== 'join') return null
  const separator = node.arguments[0]
    ? resolveStaticValue(node.arguments[0]!, symbols, bindings, seen)
    : ','
  return typeof separator === 'string' ? receiver.join(separator) : null
}

function resolveStaticConditional(
  node: ts.ConditionalExpression,
  symbols: StaticSymbols,
  bindings: Map<string, StaticValue>,
  seen: Set<string>,
): StaticValue | null {
  const branches = [node.whenTrue, node.whenFalse].map((branch) =>
    resolveStaticValue(branch, symbols, bindings, seen),
  )
  if (branches.some((branch) => branch === null)) return null
  return branches.flatMap((branch) => (Array.isArray(branch) ? branch : [branch!]))
}

function resolveStaticConcatenation(
  node: ts.BinaryExpression,
  symbols: StaticSymbols,
  bindings: Map<string, StaticValue>,
  seen: Set<string>,
): StaticValue | null {
  const left = resolveStaticValue(node.left, symbols, bindings, seen)
  const right = resolveStaticValue(node.right, symbols, bindings, seen)
  if (left === null || right === null) return null
  const leftValues = Array.isArray(left) ? left : [left]
  const rightValues = Array.isArray(right) ? right : [right]
  return leftValues.flatMap((prefix) => rightValues.map((suffix) => prefix + suffix))
}

function resolveStaticValue(
  expression: ts.Expression,
  symbols: StaticSymbols,
  bindings = new Map<string, StaticValue>(),
  seen = new Set<string>(),
): StaticValue | null {
  const node = unwrap(expression)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isArrayLiteralExpression(node)) return resolveStaticArray(node, symbols, bindings, seen)
  if (ts.isTemplateExpression(node)) return resolveStaticTemplate(node, symbols, bindings, seen)
  if (ts.isIdentifier(node)) return resolveStaticIdentifier(node, symbols, bindings, seen)
  if (ts.isConditionalExpression(node))
    return resolveStaticConditional(node, symbols, bindings, seen)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return resolveStaticConcatenation(node, symbols, bindings, seen)
  if (!ts.isCallExpression(node)) return null
  const target = unwrap(node.expression)
  if (ts.isIdentifier(target))
    return resolveStaticFunctionCall(node, target, symbols, bindings, seen)
  return ts.isPropertyAccessExpression(target)
    ? resolveStaticPropertyCall(node, target, symbols, bindings, seen)
    : null
}

function unsafeRawSql(
  expression: ts.Expression,
  symbols: StaticSymbols,
): string | null | undefined {
  const node = unwrap(expression)
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== 'unsafe'
  )
    return undefined
  const argument = node.arguments[0]
  const raw = argument && resolveStaticValue(argument, symbols)
  return typeof raw === 'string' ? raw : null
}

function renderFragment(
  expression: ts.Expression,
  constants: Map<string, ts.Expression>,
  seen: Set<string>,
): RenderedSql[] | null {
  const node = unwrap(expression)
  if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag))
    return renderTemplate(node.template, constants, { constants, functions: new Map() }, seen)
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return null
    const initializer = constants.get(node.text)
    if (!initializer) return null
    return renderFragment(initializer, constants, new Set([...seen, node.text]))
  }
  if (ts.isConditionalExpression(node)) {
    const yes = renderFragment(node.whenTrue, constants, seen)
    const no = renderFragment(node.whenFalse, constants, seen)
    return yes && no ? [...yes, ...no] : null
  }
  return null
}

function appendFragments(left: RenderedSql[], right: RenderedSql[]): RenderedSql[] {
  return left.flatMap((prefix) =>
    right.map((suffix) => ({
      sql: prefix.sql + shiftBindings(suffix.sql, prefix.bindings),
      bindings: prefix.bindings + suffix.bindings,
    })),
  )
}

function renderTemplateExpression(
  rendered: RenderedSql[],
  expression: ts.Expression,
  constants: Map<string, ts.Expression>,
  symbols: StaticSymbols,
  seen: Set<string>,
): RenderedSql[] | null {
  const fragment = renderFragment(expression, constants, seen)
  if (fragment) return appendFragments(rendered, fragment)
  const value = unwrap(expression)
  const raw = unsafeRawSql(value, symbols)
  if (raw === null) return null
  if (raw !== undefined) return rendered.map((part) => ({ ...part, sql: part.sql + raw }))
  if (ts.isCallExpression(value) && isSqlTag(value.expression))
    return rendered.map((part) => ({ ...part, sql: `${part.sql}(NULL)` }))
  return rendered.map((part) => ({
    sql: `${part.sql}$${part.bindings + 1}`,
    bindings: part.bindings + 1,
  }))
}

function renderTemplate(
  template: ts.TemplateLiteral,
  constants: Map<string, ts.Expression>,
  symbols: StaticSymbols = { constants, functions: new Map() },
  seen = new Set<string>(),
): RenderedSql[] | null {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return [{ sql: template.text, bindings: 0 }]
  let rendered: RenderedSql[] = [{ sql: template.head.text, bindings: 0 }]
  for (const span of template.templateSpans) {
    const next = renderTemplateExpression(rendered, span.expression, constants, symbols, seen)
    if (!next) return null
    rendered = next
    rendered = rendered.map((part) => ({
      ...part,
      sql: part.sql + span.literal.text,
    }))
  }
  return rendered
}

function collectConstants(source: ts.SourceFile): Map<string, ts.Expression> {
  const constants = new Map<string, ts.Expression>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node) && node.declarationList.flags & ts.NodeFlags.Const)
      for (const declaration of node.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          constants.set(declaration.name.text, declaration.initializer)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return constants
}

function collectFunctions(source: ts.SourceFile): Map<string, ts.FunctionDeclaration> {
  const functions = new Map<string, ts.FunctionDeclaration>()
  for (const statement of source.statements)
    if (ts.isFunctionDeclaration(statement) && statement.name)
      functions.set(statement.name.text, statement)
  return functions
}

type ImportedSourceCache = Map<string, ts.SourceFile | null>

function importedSource(
  file: string,
  statement: ts.ImportDeclaration,
  cache: ImportedSourceCache,
): ts.SourceFile | null {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return null
  const specifier = statement.moduleSpecifier.text
  if (!specifier.startsWith('.')) return null
  const imported = resolve(dirname(file), specifier)
  const importedFile = imported.endsWith('.ts') ? imported : `${imported}.ts`
  const cached = cache.get(importedFile)
  if (cached !== undefined || cache.has(importedFile)) return cached ?? null
  const source = existsSync(importedFile)
    ? ts.createSourceFile(
        importedFile,
        readFileSync(importedFile, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
    : null
  cache.set(importedFile, source)
  return source
}

function mergeImportedSymbols(
  symbols: StaticSymbols,
  statement: ts.ImportDeclaration,
  source: ts.SourceFile,
): void {
  const importedConstants = collectConstants(source)
  const importedFunctions = collectFunctions(source)
  const namedBindings = statement.importClause?.namedBindings
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return
  const resolvable = namedBindings.elements.some((item) => {
    const name = item.propertyName?.text ?? item.name.text
    return importedConstants.has(name) || importedFunctions.has(name)
  })
  if (!resolvable) return
  for (const [name, value] of importedConstants) symbols.constants.set(name, value)
  for (const [name, value] of importedFunctions) symbols.functions.set(name, value)
  for (const item of namedBindings.elements) {
    const importedName = item.propertyName?.text ?? item.name.text
    const constant = importedConstants.get(importedName)
    const callable = importedFunctions.get(importedName)
    if (constant) symbols.constants.set(item.name.text, constant)
    if (callable) symbols.functions.set(item.name.text, callable)
  }
}

function collectStaticSymbols(
  file: string,
  source: ts.SourceFile,
  importedSources: ImportedSourceCache = new Map(),
): StaticSymbols {
  const symbols: StaticSymbols = { constants: new Map(), functions: new Map() }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const dependency = importedSource(file, statement, importedSources)
    if (dependency) mergeImportedSymbols(symbols, statement, dependency)
  }
  for (const [name, value] of collectConstants(source)) symbols.constants.set(name, value)
  for (const [name, value] of collectFunctions(source)) symbols.functions.set(name, value)
  return symbols
}

function staticSymbolsForSource(
  file: string,
  sourceText: string,
  source: ts.SourceFile,
): StaticSymbols {
  return sourceText.includes('${') && sourceText.includes('.unsafe(')
    ? collectStaticSymbols(file, source)
    : { constants: collectConstants(source), functions: collectFunctions(source) }
}

export function extractHostedSqlFromSource(
  input: { sourceText: string; file: string; statementStart?: RegExp },
  staticSymbols?: StaticSymbols,
): {
  sites: HostedSqlSite[]
  unresolved: HostedSqlUnresolvedSite[]
} {
  const source = ts.createSourceFile(
    input.file,
    input.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const constants = staticSymbols?.constants ?? collectConstants(source)
  const symbols = staticSymbols ?? { constants, functions: collectFunctions(source) }
  const statementStart = input.statementStart ?? HOSTED_SQL_START
  const sites: HostedSqlSite[] = []
  const unresolved: HostedSqlUnresolvedSite[] = []
  if (!importsBunSql(source)) return { sites, unresolved }
  const collectTemplate = (node: ts.TaggedTemplateExpression): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const rendered = renderTemplate(node.template, constants, symbols)
    if (rendered) {
      for (const item of rendered) {
        if (!statementStart.test(item.sql)) continue
        const fingerprint = hostedSqlFingerprint(item.sql)
        sites.push({ file: input.file, line, sql: item.sql, fingerprint })
      }
      return
    }
    const firstText = ts.isNoSubstitutionTemplateLiteral(node.template)
      ? node.template.text
      : node.template.head.text
    if (!statementStart.test(firstText)) return
    const expression = node.getText(source)
    unresolved.push({
      file: input.file,
      line,
      sql: expression,
      expression,
      fingerprint: hostedSqlFingerprint(expression),
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag)) collectTemplate(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { sites, unresolved }
}

const SQL_CALL_METHODS = new Set(['exec', 'prepare', 'query', 'run'])

function couldBeSqlExpression(expression: ts.Expression): boolean {
  const value = unwrap(expression)
  if (ts.isIdentifier(value)) return /(?:sql|query|statement)/i.test(value.text)
  if (ts.isPropertyAccessExpression(value)) return /(?:sql|query|statement)/i.test(value.name.text)
  if (ts.isElementAccessExpression(value))
    return /(?:sql|query|statement)/i.test(value.expression.getText())
  if (ts.isTemplateExpression(value)) return LOCAL_HANDLE_SQL_START.test(value.head.text)
  if (ts.isBinaryExpression(value)) return couldBeSqlExpression(value.left)
  if (ts.isCallExpression(value)) return /(?:sql|query|statement)/i.test(value.expression.getText())
  return false
}

function templateStaticText(node: ts.TemplateExpression): string {
  return `${node.head.text}${node.templateSpans.map((span) => span.literal.text).join('')}`
}

function renderedSqlRiskCandidates(
  expression: ts.Expression,
  constants: Map<string, ts.Expression>,
): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const visit = (node: ts.Node): void => {
    const value = ts.isExpression(node) ? unwrap(node) : node
    if (ts.isStringLiteralLike(value)) {
      candidates.push(value.text)
      return
    }
    if (ts.isTemplateExpression(value)) candidates.push(templateStaticText(value))
    if (ts.isIdentifier(value)) {
      if (seen.has(value.text)) return
      const initializer = constants.get(value.text)
      if (initializer) {
        seen.add(value.text)
        visit(initializer)
      }
      return
    }
    ts.forEachChild(value, visit)
  }
  visit(expression)
  return candidates
}

function sqlCallSites(
  node: ts.Node,
  source: ts.SourceFile,
  file: string,
  staticSymbols: () => StaticSymbols,
  renderedUnresolvedRisk: ((sql: string) => boolean) | undefined,
  localConstants: () => Map<string, ts.Expression>,
): { sites: HostedSqlSite[]; unresolved: HostedSqlUnresolvedSite[] } {
  if (!ts.isCallExpression(node)) return { sites: [], unresolved: [] }
  const target = unwrap(node.expression)
  let method: string | null = null
  if (ts.isIdentifier(target)) method = target.text
  else if (ts.isPropertyAccessExpression(target)) method = target.name.text
  const argument = node.arguments[0]
  if (!method || !SQL_CALL_METHODS.has(method) || !argument) return { sites: [], unresolved: [] }
  const rendered =
    renderFixtureSql(argument) ??
    (() => {
      const value = resolveStaticValue(argument, staticSymbols())
      if (typeof value === 'string')
        return { statements: splitSqlStatements(value), unresolved: null, unresolvedSql: false }
      if (Array.isArray(value))
        return {
          statements: value.flatMap(splitSqlStatements),
          unresolved: null,
          unresolvedSql: false,
        }
      return null
    })()
  const line = source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1
  if (!rendered && couldBeSqlExpression(argument)) {
    const expression = argument.getText(source)
    return {
      sites: [],
      unresolved: [
        {
          file,
          line,
          sql: expression,
          expression,
          fingerprint: hostedSqlFingerprint(expression),
        },
      ],
    }
  }
  if (!rendered) return { sites: [], unresolved: [] }
  if (
    renderedUnresolvedRisk &&
    (rendered.unresolved ||
      (rendered.statements.length === 0 && couldBeSqlExpression(argument))) &&
    renderedSqlRiskCandidates(argument, localConstants()).some(renderedUnresolvedRisk)
  ) {
    const expression = (rendered.unresolved ?? argument).getText(source)
    const sql = argument.getText(source)
    return {
      sites: [],
      unresolved: [{ file, line, sql, expression, fingerprint: hostedSqlFingerprint(sql) }],
    }
  }
  return {
    sites: rendered.statements
      .filter((sql) => LOCAL_HANDLE_SQL_START.test(sql))
      .map((sql) => ({ file, line, sql, fingerprint: hostedSqlFingerprint(sql) })),
    unresolved: [],
  }
}

/** Extracts static SQL from the Bun SQL tag and SQLite database call shapes. */
export function extractSqlFromSource(input: {
  sourceText: string
  file: string
  renderedUnresolvedRisk?: (sql: string) => boolean
}): {
  sites: HostedSqlSite[]
  unresolved: HostedSqlUnresolvedSite[]
} {
  const source = ts.createSourceFile(
    input.file,
    input.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const extracted = extractHostedSqlFromSource({
    ...input,
    statementStart: LOCAL_HANDLE_SQL_START,
  })
  const importedSources: ImportedSourceCache = new Map()
  let symbols: StaticSymbols | undefined
  const staticSymbols = (): StaticSymbols =>
    (symbols ??= collectStaticSymbols(input.file, source, importedSources))
  let constants: Map<string, ts.Expression> | undefined
  const localConstants = (): Map<string, ts.Expression> =>
    (constants ??= collectConstants(source))
  const sites = [...extracted.sites]
  const unresolved = [...extracted.unresolved]
  const visit = (node: ts.Node): void => {
    const calls = sqlCallSites(
      node,
      source,
      input.file,
      staticSymbols,
      input.renderedUnresolvedRisk,
      localConstants,
    )
    sites.push(...calls.sites)
    unresolved.push(...calls.unresolved)
    ts.forEachChild(node, visit)
  }
  visit(source)
  const unique = new Map(sites.map((site) => [`${site.line}#${site.fingerprint}`, site]))
  const uniqueUnresolved = new Map(
    unresolved.map((site) => [`${site.line}#${site.fingerprint}`, site]),
  )
  return { sites: [...unique.values()], unresolved: [...uniqueUnresolved.values()] }
}

const HOSTED_FIXTURE_EXECUTORS = new Set([
  'admin',
  'asSpace',
  'asSpaces',
  'executeAsOwner',
  'postgres',
  'psql',
  'query',
  'succeeds',
])

function fixtureExecutorName(expression: ts.Expression): string | null {
  const target = unwrap(expression)
  if (ts.isIdentifier(target)) return target.text
  if (ts.isPropertyAccessExpression(target)) return target.name.text
  return null
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let start = 0
  let quote: "'" | '"' | null = null
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1
        else quote = null
      }
      continue
    }
    if (character === "'" || character === '"') quote = character
    else if (character === ';') {
      statements.push(sql.slice(start, index))
      start = index + 1
    }
  }
  statements.push(sql.slice(start))
  return statements.map((statement) => statement.trim()).filter(Boolean)
}

type RenderedFixtureSql = {
  statements: string[]
  unresolved: ts.Expression | null
  unresolvedSql: boolean
}

function fixtureInterpolationIsScalar(sql: string): boolean {
  if (/(?:=|<>|\bIN\s*\()\s*$/i.test(sql)) return true
  const statement = splitSqlStatements(sql).at(-1) ?? ''
  const valuesAt = statement.search(/\bVALUES\b/i)
  if (valuesAt < 0) return false
  let depth = 0
  let quote: "'" | '"' | null = null
  for (const character of statement.slice(valuesAt + 'VALUES'.length)) {
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') quote = character
    else if (character === '(') depth += 1
    else if (character === ')') depth -= 1
  }
  return depth > 0 && /(?:\(|,)\s*$/.test(statement)
}

function appendFixtureSpan(
  sql: string,
  span: ts.TemplateSpan,
): { sql: string; unresolved: ts.Expression | null } {
  const value = unwrap(span.expression)
  if (ts.isIdentifier(value) && value.text === 'statement') return { sql, unresolved: value }
  let suffix = span.literal.text
  const exactlySingleQuoted = sql.endsWith("'") && suffix.startsWith("'")
  if (exactlySingleQuoted) {
    sql = sql.slice(0, -1)
    suffix = suffix.slice(1)
  }
  const singleQuoted = !exactlySingleQuoted && (sql.match(/'/g)?.length ?? 0) % 2 === 1
  const quotedLiteral = exactlySingleQuoted || singleQuoted
  const stringProducingConditional =
    ts.isConditionalExpression(value) &&
    [value.whenTrue, value.whenFalse].some(
      (branch) => ts.isStringLiteralLike(unwrap(branch)) || ts.isTemplateLiteral(unwrap(branch)),
    )
  if (!quotedLiteral && (!fixtureInterpolationIsScalar(sql) || stringProducingConditional))
    return { sql, unresolved: value }
  return { sql: `${sql}NULL${suffix}`, unresolved: null }
}

function renderFixtureSql(expression: ts.Expression): RenderedFixtureSql | null {
  const node = unwrap(expression)
  if (ts.isStringLiteralLike(node))
    return {
      statements: splitSqlStatements(node.text),
      unresolved: null,
      unresolvedSql: false,
    }
  if (!ts.isTemplateExpression(node)) return null
  let sql = node.head.text
  for (const span of node.templateSpans) {
    const appended = appendFixtureSpan(sql, span)
    if (appended.unresolved)
      return {
        statements: [],
        unresolved: appended.unresolved,
        unresolvedSql: splitSqlStatements(sql).some((statement) =>
          HOSTED_SQL_START.test(statement),
        ),
      }
    sql = appended.sql
  }
  return {
    statements: splitSqlStatements(sql),
    unresolved: null,
    unresolvedSql: false,
  }
}

type ExtractedFixtureSql = {
  sites: HostedSqlSite[]
  unresolved: HostedSqlUnresolvedSite[]
  selected: boolean
}

function sourceContainsPotentialHostedSql(source: ts.SourceFile): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isStringLiteralLike(node) &&
      splitSqlStatements(node.text).some((sql) => HOSTED_SQL_START.test(sql))
    ) {
      found = true
      return
    }
    if (
      ts.isTemplateExpression(node) &&
      splitSqlStatements(node.head.text).some((sql) => HOSTED_SQL_START.test(sql))
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function unqualifiedTableReference(sql: string, table: string): boolean {
  return new RegExp(`(^|[^.a-zA-Z0-9_])${table}\\b`, 'i').test(sql)
}

function filterTemporaryTableStatements(rendered: RenderedFixtureSql): RenderedFixtureSql {
  const temporaryTables = new Set<string>()
  const statements: string[] = []
  for (const statement of rendered.statements) {
    const created = statement.match(
      /^CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)/i,
    )
    if (created) {
      temporaryTables.add(created[1]!.toLowerCase())
      continue
    }
    if ([...temporaryTables].some((table) => unqualifiedTableReference(statement, table))) continue
    statements.push(statement)
  }
  return { ...rendered, statements }
}

function fixtureSite(
  source: ts.SourceFile,
  file: string,
  argument: ts.Expression,
): ExtractedFixtureSql {
  const initial = renderFixtureSql(argument)
  const rendered = initial && filterTemporaryTableStatements(initial)
  if (!rendered) return { sites: [], unresolved: [], selected: false }
  const line = source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1
  const sites = rendered.statements
    .filter((sql) => HOSTED_SQL_START.test(sql))
    .map((sql) => ({
      file,
      line,
      sql,
      fingerprint: hostedSqlFingerprint(sql),
    }))
  if (!rendered.unresolved || !rendered.unresolvedSql)
    return { sites, unresolved: [], selected: sites.length > 0 }
  const expression = rendered.unresolved.getText(source)
  const sql = argument.getText(source)
  return {
    sites,
    unresolved: [{ file, line, sql, expression, fingerprint: hostedSqlFingerprint(sql) }],
    selected: true,
  }
}

function forwardedFixtureParameters(source: ts.SourceFile): Map<string, number> {
  const wrappers = new Map<string, number>()
  const inspect = (
    name: string,
    parameters: readonly ts.ParameterDeclaration[],
    body: ts.Node,
  ): void => {
    const parameterIndex = new Map<string, number>()
    parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) parameterIndex.set(parameter.name.text, index)
    })
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const executor = fixtureExecutorName(node.expression)
        const argument = node.arguments.at(-1)
        if (executor && HOSTED_FIXTURE_EXECUTORS.has(executor) && argument) {
          const text = argument.getText(source)
          for (const [parameter, index] of parameterIndex)
            if (new RegExp(`\\$\\{\\s*${parameter}\\s*\\}`).test(text)) wrappers.set(name, index)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      inspect(statement.name.text, statement.parameters, statement.body)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)) &&
          declaration.initializer.body
        )
          inspect(
            declaration.name.text,
            declaration.initializer.parameters,
            declaration.initializer.body,
          )
      }
  }
  return wrappers
}

function fixtureSqlFromCall(
  source: ts.SourceFile,
  file: string,
  node: ts.CallExpression,
): ExtractedFixtureSql {
  const target = unwrap(node.expression)
  const executor = fixtureExecutorName(target)
  const unsafe = ts.isPropertyAccessExpression(target) && target.name.text === 'unsafe'
  const argument = node.arguments.at(-1)
  const selectedExecutor =
    executor &&
    HOSTED_FIXTURE_EXECUTORS.has(executor) &&
    (executor !== 'query' || ts.isIdentifier(target))
  if ((!selectedExecutor && !unsafe) || !argument)
    return { sites: [], unresolved: [], selected: false }
  return fixtureSite(source, file, argument)
}

export function extractHostedFixtureSqlFromSource(input: {
  sourceText: string
  file: string
}): ExtractedFixtureSql {
  const source = ts.createSourceFile(
    input.file,
    input.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const sites: HostedSqlSite[] = []
  const unresolved: HostedSqlUnresolvedSite[] = []
  const forwarded = forwardedFixtureParameters(source)
  let selected = sourceContainsPotentialHostedSql(source)
  const append = (extracted: ExtractedFixtureSql): void => {
    sites.push(...extracted.sites)
    unresolved.push(...extracted.unresolved)
    selected ||= extracted.selected
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      append(fixtureSqlFromCall(source, input.file, node))
      const target = unwrap(node.expression)
      if (ts.isIdentifier(target)) {
        const parameter = forwarded.get(target.text)
        const argument = parameter === undefined ? undefined : node.arguments[parameter]
        if (argument) append(fixtureSite(source, input.file, argument))
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const executor = fixtureExecutorName(node.tag)
      if (executor && HOSTED_FIXTURE_EXECUTORS.has(executor))
        append(fixtureSite(source, input.file, node.template))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { sites, unresolved, selected }
}

export function extractHostedSql(root: string): {
  sites: HostedSqlSite[]
  unresolved: HostedSqlUnresolvedSite[]
} {
  const sites: HostedSqlSite[] = []
  const unresolved: HostedSqlUnresolvedSite[] = []
  const emptyFixtureFiles: string[] = []
  const fixtureFilesWithUnexpectedSql: string[] = []
  const staleNoSqlFixtureFiles = new Set(HOSTED_FIXTURE_IMPORTS_WITHOUT_SQL)
  for (const concern of ['orchestrator/src', 'hub/src', 'shared']) {
    for (const file of productionTypeScriptFiles(resolve(root, concern))) {
      const sourceText = readFileSync(file, 'utf8')
      const source = ts.createSourceFile(
        file,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
      const extracted = extractHostedSqlFromSource(
        { sourceText, file: relative(root, file) },
        staticSymbolsForSource(file, sourceText, source),
      )
      sites.push(...extracted.sites)
      unresolved.push(...extracted.unresolved)
    }
  }
  for (const file of hostedFixtureTypeScriptFiles(root)) {
    const sourceText = readFileSync(file, 'utf8')
    const path = relative(root, file)
    const localTableLifetimes = [
      ...sourceText.matchAll(
        /\b(CREATE|DROP)\s+(?:(?:TEMP|TEMPORARY)\s+)?TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi,
      ),
    ].map((match) => ({
      action: match[1]!.toUpperCase(),
      table: match[2]!.toLowerCase(),
      line: sourceText.slice(0, match.index).split('\n').length,
    }))
    const belongsToLocalTable = (site: HostedSqlSite): boolean =>
      localTableLifetimes.some(
        (event) =>
          event.action === 'CREATE' &&
          event.line <= site.line &&
          !localTableLifetimes.some(
            (later) =>
              later.action === 'DROP' &&
              later.table === event.table &&
              later.line > event.line &&
              later.line < site.line,
          ) &&
          unqualifiedTableReference(site.sql, event.table),
      )
    const extracted = extractHostedSqlFromSource({ sourceText, file: path })
    const productionSites = extracted.sites.filter((site) => !belongsToLocalTable(site))
    const productionUnresolved = extracted.unresolved.filter((site) => !belongsToLocalTable(site))
    sites.push(...productionSites)
    unresolved.push(...productionUnresolved)
    const fixtures = extractHostedFixtureSqlFromSource({
      sourceText,
      file: path,
    })
    const fixtureSites = fixtures.sites.filter((site) => !belongsToLocalTable(site))
    const fixtureUnresolved = fixtures.unresolved.filter((site) => !belongsToLocalTable(site))
    sites.push(...fixtureSites)
    unresolved.push(...fixtureUnresolved)
    const contribution =
      productionSites.length +
      productionUnresolved.length +
      fixtureSites.length +
      fixtureUnresolved.length
    staleNoSqlFixtureFiles.delete(path)
    if (contribution > 0 && HOSTED_FIXTURE_IMPORTS_WITHOUT_SQL.has(path))
      fixtureFilesWithUnexpectedSql.push(path)
    else if (contribution === 0 && !HOSTED_FIXTURE_IMPORTS_WITHOUT_SQL.has(path))
      emptyFixtureFiles.push(path)
  }
  if (emptyFixtureFiles.length)
    throw new Error(
      `Hosted fixture files contributed no prepared or unresolved SQL sites:\n${emptyFixtureFiles.join('\n')}`,
    )
  if (staleNoSqlFixtureFiles.size)
    throw new Error(
      `Hosted fixture no-SQL manifest entries are stale or outside the import closure:\n${[...staleNoSqlFixtureFiles].join('\n')}`,
    )
  if (fixtureFilesWithUnexpectedSql.length)
    throw new Error(
      `Hosted fixture no-SQL manifest entries now contribute SQL:\n${fixtureFilesWithUnexpectedSql.join('\n')}`,
    )
  return { sites, unresolved }
}
