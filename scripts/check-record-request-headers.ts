#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['shared', 'hub/src', 'orchestrator/src'] as const
const HELPER_MODULE = 'shared/record-request-headers.ts'
const TEST_FILE = /(?:^|\/)(?:test|tests)\/|(?:^|\/)(?:test-[^/]+|[^/]+\.test)\.ts$/

export const THIRD_PARTY_BEARER_HEADER_FILES = {
  'hub/src/mcp.ts': 'external tracker MCP endpoint, not the record API or hosted hub',
  'orchestrator/src/agent/openrouter-key-budget.ts':
    'external model provider endpoint, not the record API or hosted hub',
  'orchestrator/src/transport/transport-acp.ts':
    'agent transport authentication, not the record API or hosted hub',
  'shared/typed-question/client.ts':
    'external typed-question provider endpoint, not the record API or hosted hub',
} as const

type HeaderConstructionKind = 'caller' | 'space' | 'bearer'

export type RecordRequestHeaderViolation = {
  file: string
  line: number
  kind: HeaderConstructionKind
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

function headerKind(name: string | undefined): HeaderConstructionKind | undefined {
  const normalized = name?.toLowerCase()
  if (normalized === 'x-bottega-caller') return 'caller'
  if (normalized === 'x-record-space') return 'space'
  return undefined
}

function isBearerValue(node: ts.Node | undefined): boolean {
  if (!node) return false
  if (ts.isTemplateExpression(node)) return node.head.text === 'Bearer '
  return literalText(node)?.startsWith('Bearer ') ?? false
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
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

function constructionKind(node: ts.Node): HeaderConstructionKind | undefined {
  if (ts.isPropertyAssignment(node)) {
    const name = propertyName(node.name)
    return (
      headerKind(name) ??
      (name?.toLowerCase() === 'authorization' && isBearerValue(node.initializer)
        ? 'bearer'
        : undefined)
    )
  }

  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text
    if (method !== 'set' && method !== 'append') return undefined
    const name = literalText(node.arguments[0])
    return (
      headerKind(name) ??
      (name?.toLowerCase() === 'authorization' && isBearerValue(node.arguments[1])
        ? 'bearer'
        : undefined)
    )
  }

  if (ts.isArrayLiteralExpression(node)) {
    const name = literalText(node.elements[0])
    return (
      headerKind(name) ??
      (name?.toLowerCase() === 'authorization' && isBearerValue(node.elements[1])
        ? 'bearer'
        : undefined)
    )
  }

  if (ts.isObjectLiteralExpression(node)) {
    const name = literalText(propertyValue(node, 'name'))
    const value = propertyValue(node, 'value')
    if (name?.toLowerCase() === 'authorization' && isBearerValue(value)) return 'bearer'
  }
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
  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}: request header construction must use recordRequestHeaders`,
    )
  }
  if (violations.length > 0) return 1
  console.log('check-record-request-headers: ok')
  return 0
}

if (import.meta.main) process.exit(run())
