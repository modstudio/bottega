import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
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
const SQL_START = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH)\b/i

function hostedSqlFingerprint(sql: string): string {
  return createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

function productionTypeScriptFiles(directory: string): string[] {
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
  'orchestrator/test/fixtures/record-session.ts',
  // Records gate fixture timings and intentionally owns no SQL.
  'orchestrator/test/gate-phase-timing.ts',
  'orchestrator/test/gate-timings-reporter.ts',
  'orchestrator/test/preload.ts',
  // Registers hosted canon HTTP assertions and intentionally owns no SQL.
  'orchestrator/test/canon-import-proof.ts',
  'orchestrator/test/postgres-board-api-values.ts',
  'orchestrator/test/postgres-board-cache-client.ts',
  'orchestrator/test/postgres-board-claim-api-proof.ts',
  'orchestrator/test/postgres-board-route-edge-proof.ts',
  'orchestrator/test/postgres-board-reply-proof.ts',
  'orchestrator/test/postgres-board-shared-space-api-proof.ts',
  'orchestrator/test/postgres-canon-refusal-proof.ts',
  'orchestrator/test/postgres-customer-auth-proof.ts',
  'orchestrator/test/postgres-doc-order-proof.ts',
  'orchestrator/test/postgres-project-identity-proof.ts',
  'orchestrator/test/postgres-rls-values.ts',
])

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
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

function renderFragment(
  expression: ts.Expression,
  constants: Map<string, ts.Expression>,
  seen: Set<string>,
): RenderedSql[] | null {
  const node = unwrap(expression)
  if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag))
    return renderTemplate(node.template, constants, seen)
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

function renderTemplate(
  template: ts.TemplateLiteral,
  constants: Map<string, ts.Expression>,
  seen = new Set<string>(),
): RenderedSql[] | null {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return [{ sql: template.text, bindings: 0 }]
  let rendered: RenderedSql[] = [{ sql: template.head.text, bindings: 0 }]
  for (const span of template.templateSpans) {
    const fragment = renderFragment(span.expression, constants, seen)
    if (fragment) rendered = appendFragments(rendered, fragment)
    else {
      const expression = unwrap(span.expression)
      if (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === 'unsafe'
      )
        return null
      if (ts.isCallExpression(expression) && isSqlTag(expression.expression)) {
        rendered = rendered.map((part) => ({
          ...part,
          sql: `${part.sql}(NULL)`,
        }))
        rendered = rendered.map((part) => ({
          ...part,
          sql: part.sql + span.literal.text,
        }))
        continue
      }
      rendered = rendered.map((part) => ({
        sql: `${part.sql}$${part.bindings + 1}`,
        bindings: part.bindings + 1,
      }))
    }
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

export function extractHostedSqlFromSource(input: { sourceText: string; file: string }): {
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
  const constants = collectConstants(source)
  const sites: HostedSqlSite[] = []
  const unresolved: HostedSqlUnresolvedSite[] = []
  if (!importsBunSql(source)) return { sites, unresolved }
  const collectTemplate = (node: ts.TaggedTemplateExpression): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const rendered = renderTemplate(node.template, constants)
    if (rendered) {
      for (const item of rendered) {
        if (!SQL_START.test(item.sql)) continue
        const fingerprint = hostedSqlFingerprint(item.sql)
        sites.push({ file: input.file, line, sql: item.sql, fingerprint })
      }
      return
    }
    const firstText = ts.isNoSubstitutionTemplateLiteral(node.template)
      ? node.template.text
      : node.template.head.text
    if (!SQL_START.test(firstText)) return
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
        unresolvedSql: splitSqlStatements(sql).some((statement) => SQL_START.test(statement)),
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
      splitSqlStatements(node.text).some((sql) => SQL_START.test(sql))
    ) {
      found = true
      return
    }
    if (
      ts.isTemplateExpression(node) &&
      splitSqlStatements(node.head.text).some((sql) => SQL_START.test(sql))
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
    .filter((sql) => SQL_START.test(sql))
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
      const extracted = extractHostedSqlFromSource({
        sourceText: readFileSync(file, 'utf8'),
        file: relative(root, file),
      })
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
