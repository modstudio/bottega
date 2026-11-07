// Direct active-space writes are centralized so every CLI write is verified by a whoami re-read.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['orchestrator/src', 'hub/src', 'hub/data/src', 'hub/web/src'] as const
const VERIFYING_HELPER = {
  file: 'orchestrator/src/record/record-space.ts',
  functionName: 'setAndVerifyActiveRecordSpace',
}

type AdmittedWrite = { file: string; functionName: string; reason: string }

const ADMITTED_ACTIVE_SPACE_WRITES: readonly AdmittedWrite[] = [
  {
    file: 'orchestrator/src/record/record-auth.ts',
    functionName: 'recordDatabaseHooks',
    reason:
      'the server session-create hook establishes the initial active space before whoami exists',
  },
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

function sourceFiles(): string[] {
  const files: string[] = []
  const collect = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) collect(absolute)
      else if (entry.isFile()) files.push(relative(ROOT, absolute))
    }
  }
  for (const root of SOURCE_ROOTS) {
    const source = resolve(ROOT, root)
    if (existsSync(source)) collect(source)
  }
  return files.filter(productionTypeScript).sort()
}

export function activeSpaceSourceViolations(): string[] {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  return activeSpaceWriteViolations(activeSpaceWriteCalls(files))
}

function enclosingFunctionName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text
    }
  }
  return null
}

function isSetActiveOrganizationCall(node: ts.CallExpression): boolean {
  return (
    (ts.isIdentifier(node.expression) && node.expression.text === 'setActiveOrganization') ||
    (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setActiveOrganization')
  )
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
      if (ts.isCallExpression(node) && isSetActiveOrganizationCall(node)) {
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
