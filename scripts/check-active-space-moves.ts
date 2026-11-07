// This guard recognizes every setActiveOrganization access: bare identifiers, property access,
// string-literal element access, destructuring bindings, and method references passed as values.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { enclosingFunctionName, sourceFiles } from './source-analysis.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['orchestrator/src', 'hub/src', 'hub/data/src', 'hub/web/src'] as const
const VERIFYING_HELPER = {
  file: 'orchestrator/src/record/record-space.ts',
  functionName: 'setAndVerifyActiveRecordSpace',
}

type AdmittedWrite = { file: string; functionName: string; reason: string }

const ADMITTED_ACTIVE_SPACE_WRITES: readonly AdmittedWrite[] = [
  {
    file: 'hub/web/src/routes/accept-invitation.$id.tsx',
    functionName: 'act',
    reason:
      'the web invitation flow reloads the application immediately after its browser-session write',
  },
]

export type ActiveSpaceWriteCall = { file: string; line: number; functionName: string | null }

function productionTypeScript(path: string): boolean {
  return (
    (path.endsWith('.ts') || path.endsWith('.tsx')) &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.fixture.ts')
  )
}

export function activeSpaceSourceViolations(): string[] {
  const files = Object.fromEntries(
    sourceFiles(ROOT, SOURCE_ROOTS, productionTypeScript).map((path) => [
      path,
      readFileSync(resolve(ROOT, path), 'utf8'),
    ]),
  )
  return activeSpaceWriteViolations(activeSpaceWriteCalls(files))
}

function isIdentifierAccess(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isBindingElement(parent)) return false
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false
  if (
    ts.isMethodSignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isPropertyAssignment(parent)
  ) {
    return parent.name !== node
  }
  if (ts.isLiteralTypeNode(parent) || ts.isImportSpecifier(parent)) return false
  return true
}

function isSetActiveOrganizationAccess(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'setActiveOrganization'
  if (ts.isElementAccessExpression(node)) {
    return (
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'setActiveOrganization'
    )
  }
  if (ts.isBindingElement(node)) {
    const member = node.propertyName ?? node.name
    return ts.isIdentifier(member) && member.text === 'setActiveOrganization'
  }
  return ts.isIdentifier(node) && node.text === 'setActiveOrganization' && isIdentifierAccess(node)
}

export function activeSpaceWriteCalls(
  files: Readonly<Record<string, string>>,
): ActiveSpaceWriteCall[] {
  const findings: ActiveSpaceWriteCall[] = []
  for (const [path, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!productionTypeScript(path)) continue
    const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
    const visit = (node: ts.Node): void => {
      if (isSetActiveOrganizationAccess(node)) {
        findings.push({
          file: path,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          functionName: enclosingFunctionName(node),
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return findings
}

export function activeSpaceWriteViolations(findings: readonly ActiveSpaceWriteCall[]): string[] {
  return findings.flatMap((finding) => {
    if (
      finding.file === VERIFYING_HELPER.file &&
      finding.functionName === VERIFYING_HELPER.functionName
    ) {
      return []
    }
    if (
      ADMITTED_ACTIVE_SPACE_WRITES.some(
        (entry) => entry.file === finding.file && entry.functionName === finding.functionName,
      )
    ) {
      return []
    }
    return [
      `${finding.file}:${finding.line}: setActiveOrganization bypasses ${VERIFYING_HELPER.functionName} in ${VERIFYING_HELPER.file}`,
    ]
  })
}

if (import.meta.main) {
  const violations = activeSpaceSourceViolations()
  for (const violation of violations) console.error(violation)
  if (violations.length) process.exit(1)
  console.log(
    `check-active-space-moves: ok (${ADMITTED_ACTIVE_SPACE_WRITES.length} named server and web paths)`,
  )
}
