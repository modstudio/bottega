#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import ts from 'typescript'
import { CALLER_HEADER_NAME } from '../shared/record-caller.ts'
import { RECORD_SPACE_HEADER_NAME } from '../shared/record-request-headers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['shared', 'hub/src', 'hub/web/scripts', 'orchestrator/src'] as const
const RECORD_FETCH_SOURCE_ROOTS = [
  'shared',
  'hub/src',
  'orchestrator/src',
  'cli',
  'scripts',
] as const
const HELPER_MODULE = 'shared/record-request-headers.ts'
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.ts$/

const THIRD_PARTY_BEARER_HEADER_FILES = {
  'hub/src/mcp.ts': 'external tracker MCP endpoint, not the record API or hosted hub',
  'orchestrator/src/agent/openrouter-key-budget.ts':
    'external model provider endpoint, not the record API or hosted hub',
  'orchestrator/src/transport/transport-acp.ts':
    'agent transport authentication, not the record API or hosted hub',
  'shared/typed-question/client.ts':
    'external typed-question provider endpoint, not the record API or hosted hub',
} as const

const NON_RECORD_FETCH_FILES = {
  'orchestrator/src/agent/model-host.ts': 'model host endpoint, not the record API',
  'orchestrator/src/agent/openrouter-key-budget.ts':
    'external model provider endpoint, not the record API',
  'scripts/record-rehearse.ts': 'Fly Machines API, not the record API',
  'scripts/smoke-binary.ts': 'ephemeral smoke-test servers, not the record API',
  'shared/bounded-fetch.ts': 'defines the transport passed into tracedRecordFetch',
  'shared/typed-question/client.ts': 'external typed-question provider, not the record API',
} as const

type HeaderConstructionKind = 'caller' | 'space' | 'bearer'

export type RecordRequestHeaderViolation = {
  file: string
  line: number
  kind: HeaderConstructionKind
}

export type RecordFetchViolation = { file: string; line: number }

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

function headerKind(name: string | undefined): HeaderConstructionKind | undefined {
  const normalized = name?.toLowerCase()
  if (normalized === CALLER_HEADER_NAME.toLowerCase() || name === 'CALLER_HEADER_NAME')
    return 'caller'
  if (normalized === RECORD_SPACE_HEADER_NAME || name === 'RECORD_SPACE_HEADER_NAME') return 'space'
  return undefined
}

function isBearerValue(node: ts.Node | undefined): boolean {
  if (!node) return false
  if (ts.isTemplateExpression(node)) return node.head.text === 'Bearer '
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return literalText(node.left)?.startsWith('Bearer ') ?? false
  return literalText(node)?.startsWith('Bearer ') ?? false
}

function headerName(node: ts.Node | undefined): string | undefined {
  if (node && ts.isIdentifier(node)) return node.text
  return literalText(node)
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
  if (ts.isComputedPropertyName(node)) return headerName(node.expression)
  return undefined
}

function propertyValue(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (propertyName(property.name)?.toLowerCase() === name) return property.initializer
  }
  return undefined
}

function namedValueKind(name: string | undefined, value: ts.Node | undefined) {
  return (
    headerKind(name) ??
    (name?.toLowerCase() === 'authorization' && isBearerValue(value) ? 'bearer' : undefined)
  )
}

function propertyConstructionKind(node: ts.PropertyAssignment) {
  return namedValueKind(propertyName(node.name), node.initializer)
}

function callConstructionKind(node: ts.CallExpression) {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined
  const method = node.expression.name.text
  if (method !== 'set' && method !== 'append') return undefined
  return namedValueKind(headerName(node.arguments[0]), node.arguments[1])
}

function arrayConstructionKind(node: ts.ArrayLiteralExpression) {
  return namedValueKind(headerName(node.elements[0]), node.elements[1])
}

function objectConstructionKind(node: ts.ObjectLiteralExpression) {
  const name = literalText(propertyValue(node, 'name'))
  return name?.toLowerCase() === 'authorization' && isBearerValue(propertyValue(node, 'value'))
    ? 'bearer'
    : undefined
}

function constructionKind(node: ts.Node): HeaderConstructionKind | undefined {
  if (ts.isPropertyAssignment(node)) return propertyConstructionKind(node)
  if (ts.isCallExpression(node)) return callConstructionKind(node)
  if (ts.isArrayLiteralExpression(node)) return arrayConstructionKind(node)
  if (ts.isObjectLiteralExpression(node)) return objectConstructionKind(node)
  return undefined
}

/** Find request-header construction that bypasses recordRequestHeaders. */
export function recordRequestHeaderViolations(
  source: string,
  file: string,
): RecordRequestHeaderViolation[] {
  if (file === HELPER_MODULE) return []
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const violations: RecordRequestHeaderViolation[] = []
  const visit = (node: ts.Node) => {
    const kind = constructionKind(node)
    const bearerExempt = kind === 'bearer' && file in THIRD_PARTY_BEARER_HEADER_FILES
    if (kind && !bearerExempt) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      violations.push({ file, line: line + 1, kind })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function calledName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text
  return undefined
}

function unparenthesized(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression
  return node
}

function isFetchFallback(node: ts.Expression): boolean {
  node = unparenthesized(node)
  if (ts.isIdentifier(node)) return node.text === 'fetch'
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    (isFetchFallback(node.left) || isFetchFallback(node.right))
  )
}

function sameScopeInitializer(
  identifier: ts.Identifier,
  call: ts.CallExpression,
): ts.Expression | undefined {
  let scope: ts.Node | undefined = call.parent
  while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent
  if (!scope || (!ts.isBlock(scope) && !ts.isSourceFile(scope))) return undefined
  for (const statement of scope.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text)
        return declaration.initializer
  }
  return undefined
}

function nodeText(node: ts.Node | undefined, sourceFile: ts.SourceFile): string {
  return node?.getText(sourceFile) ?? ''
}

/** Find record or hosted API fetches that bypass tracedRecordFetch. */
export function recordFetchViolations(source: string, file: string): RecordFetchViolation[] {
  if (file === 'shared/record-call-trace.ts' || file in NON_RECORD_FETCH_FILES) return []
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const violations: RecordFetchViolation[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const fallbackFetch = isFetchFallback(node.expression)
      const name = fallbackFetch ? 'fetch' : calledName(node)
      const firstArgument = node.arguments[0]
      const initializer =
        firstArgument && ts.isIdentifier(firstArgument)
          ? sameScopeInitializer(firstArgument, node)
          : undefined
      const first =
        `${nodeText(firstArgument, sourceFile)} ${nodeText(initializer, sourceFile)}`.trim()
      const hostedBoundedFetch =
        name === 'boundedFetch' && literalText(node.arguments[0]) === 'hosted-api'
      const opaqueHostedSend =
        name === 'fetch' &&
        ts.isPropertyAccessExpression(node.expression) &&
        /(?:^|\.)input\.url$/.test(first)
      const recordResolvedFetch =
        name === 'fetch' &&
        /(?:resolveRecordApiUrl|resolveHostedUrl|recordApiUrl|hostedUrl)/.test(first)
      if (
        name === 'hostedApiFetch' ||
        hostedBoundedFetch ||
        opaqueHostedSend ||
        recordResolvedFetch
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push({ file, line: line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return violations
}

function run(): number {
  const violations: RecordRequestHeaderViolation[] = []
  for (const sourceRoot of SOURCE_ROOTS) {
    for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, sourceRoot) })) {
      const file = join(sourceRoot, relative)
      if (relative.includes('node_modules/') || TEST_FILE.test(file)) continue
      violations.push(
        ...recordRequestHeaderViolations(readFileSync(join(ROOT, file), 'utf8'), file),
      )
    }
  }
  const fetchViolations: RecordFetchViolation[] = []
  for (const sourceRoot of RECORD_FETCH_SOURCE_ROOTS) {
    for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(ROOT, sourceRoot) })) {
      const file = join(sourceRoot, relative)
      if (relative.includes('node_modules/') || TEST_FILE.test(file)) continue
      fetchViolations.push(...recordFetchViolations(readFileSync(join(ROOT, file), 'utf8'), file))
    }
  }
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}: request header construction must use recordRequestHeaders`,
    )
  }
  for (const violation of fetchViolations)
    console.error(
      `${violation.file}:${violation.line}: record and hosted API requests must use tracedRecordFetch`,
    )
  if (violations.length > 0 || fetchViolations.length > 0) return 1
  console.log('check-record-request-headers: ok')
  return 0
}

if (import.meta.main) process.exit(run())
