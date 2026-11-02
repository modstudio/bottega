// This guard recognizes literal argv at production git call sites, including git-prefixed spawns.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { PLATFORM_NAME } from '../shared/brand.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['orchestrator/src', 'hub/src', 'shared'] as const
const MOVER_MODULE = 'orchestrator/src/database/machine-update.ts'
const MOVER_ADAPTER = 'orchestrator/src/database/machine-update-mover.ts'

type AdmittedMove = {
  file: string
  functionName: string
  command: string
  reason: string
}

const ADMITTED_NON_MAIN_MOVES: readonly AdmittedMove[] = [
  {
    file: 'orchestrator/src/recipe/tree-refresh.ts',
    functionName: 'fastForwardTree',
    command: 'merge --ff-only',
    reason: `fastForwardTree moves either a non-main worktree or a registered main checkout that is not the running ${PLATFORM_NAME} installation`,
  },
  {
    file: 'orchestrator/src/release/release-required.ts',
    functionName: 'moveNonInstallationMainCheckout',
    command: 'merge --ff-only',
    reason: `moves a registered main checkout that is not the running ${PLATFORM_NAME} installation, which has no store to migrate`,
  },
  {
    file: 'orchestrator/src/run/run-resume-claim.ts',
    functionName: 'restoreResumeIfNeeded',
    command: 'reset --hard',
    reason: 'restoreResumeIfNeeded targets only a freshly created run tree',
  },
]

export type BranchMoveCall = {
  file: string
  line: number
  functionName: string | null
  command: string
}

function productionTypeScript(path: string): boolean {
  return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.fixture.ts')
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

function literalArgv(node: ts.CallExpression): Array<string | null> | null {
  const first = node.arguments[0]
  if (!first || !ts.isArrayLiteralExpression(first)) return null
  return first.elements.map((element) =>
    ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)
      ? element.text
      : null,
  )
}

function branchMove(argv: readonly (string | null)[]): string | null {
  let command = argv
  if (command[0] === 'git') {
    let offset = 1
    while (command[offset] === '-C' && offset + 1 < command.length) offset += 2
    command = command.slice(offset)
  }
  if (command[0] === 'pull') return 'pull'
  if (command[0] === 'merge' && command.includes('--ff-only')) return 'merge --ff-only'
  if (command[0] === 'reset' && command.includes('--hard')) return 'reset --hard'
  return null
}

/** Find direct calls through the production git adapters that can move a branch. */
export function branchMoveCalls(files: Readonly<Record<string, string>>): BranchMoveCall[] {
  const findings: BranchMoveCall[] = []
  for (const [path, source] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!productionTypeScript(path)) continue
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const argv = literalArgv(node)
        const command = argv ? branchMove(argv) : null
        if (command) {
          findings.push({
            file: path,
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            functionName: enclosingFunctionName(node),
            command,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return findings
}

export function mainCheckoutMoveViolations(findings: readonly BranchMoveCall[]): string[] {
  return findings.flatMap((finding) => {
    if (finding.file === MOVER_MODULE) return []
    const admitted = ADMITTED_NON_MAIN_MOVES.some(
      (entry) =>
        entry.file === finding.file &&
        entry.functionName === finding.functionName &&
        entry.command === finding.command,
    )
    if (admitted) return []
    const remedy = finding.file.startsWith('orchestrator/src/')
      ? `route it through moveRegisteredMainCheckout in ${MOVER_ADAPTER}, which runs machine update`
      : `move the call into the orchestrator mover ${MOVER_ADAPTER}, or remove it`
    return [
      `${finding.file}:${finding.line}: ${finding.command} may move a registered main checkout; ${remedy}`,
    ]
  })
}

if (import.meta.main) {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  const violations = mainCheckoutMoveViolations(branchMoveCalls(files))
  for (const violation of violations) console.error(violation)
  if (violations.length) process.exit(1)
  console.log(
    `check-main-checkout-moves: ok (${ADMITTED_NON_MAIN_MOVES.length} named non-main moves)`,
  )
}
