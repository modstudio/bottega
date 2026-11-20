/**
 * Refuse install-root and hook runtime paths that a compiled release does not ship.
 *
 * Hook declarations cover every non-test file and the matched repo-relative reads. The read
 * scanner does not infer Python paths built through parents[1], cwd joins, environment values or
 * f-strings, and TypeScript hooks that import ../src must be declared checkout-only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { EMBEDDED_ASSET_PREFIXES, RUNTIME_ASSETS } from '../shared/embedded-assets.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const runtimePaths = new Set(RUNTIME_ASSETS.map(({ packagePath }) => packagePath))

/** Source-mode paths that are deliberately unavailable in a compiled distribution. */
const CHECKOUT_ONLY_RUNTIME_PATHS = new Map([
  ['<install-root>', 'callers need the installation identity, not an asset'],
  ['node_modules/.bin/codex-acp', 'transport declares codex-acp is not an install asset'],
  ['orchestrator', 'Bun module resolution is reached only by the source transport'],
  [`bin/${PLATFORM_SLUG}`, 'source-mode self-spawn executable'],
  ['bin/retrieval-search', 'source-mode hidden entry executable'],
  [`cli/${PLATFORM_SLUG}.ts`, 'source-mode run-exec entry'],
  ['orchestrator/src/ask/ask-proxy.ts', 'source-mode ask proxy entry'],
  ['orchestrator/src/check/check-attribution.ts', 'source-mode hidden check entry'],
  ['orchestrator/src/check/check-strict-schema.ts', 'source-mode hidden schema entry'],
])

const DYNAMIC_ASSET_PATH_ALLOWANCES = new Map([
  ['shared/runtime-assets.ts', 'the resolver validates its argument against RUNTIME_ASSETS'],
  ['shared/self-spawn.ts', 'source-mode entry paths are selected by the closed entry protocol'],
  [
    'hub/src/local-app-static.ts',
    'resolveInstallFile validates dashboard paths against embedded files',
  ],
])

/** Hook files that intentionally require a checkout rather than an extracted runtime. */
const CHECKOUT_ONLY_HOOKS = new Map([
  [
    'orchestrator/hooks/canon-edit-guard.ts',
    'imports orchestrator/src and is rendered only by checkout project settings',
  ],
  [
    'orchestrator/hooks/process_heartbeat_shell.py',
    'drives checkout-scoped heartbeat shell tests and resolves project checkout files',
  ],
  [
    'orchestrator/hooks/heartbeat_decision_fixture.py',
    'fixture imported only by heartbeat decision tests',
  ],
])

export type RuntimeAssetFinding = { path: string; line: number; asset: string }

function ignored(path: string): boolean {
  return (
    /(?:^|\/)(?:test|tests|fixtures|scripts)(?:\/|$)/.test(path) ||
    /(?:\.test|\.fixture)\.tsx?$/.test(path)
  )
}

function staticAssetPath(node: ts.CallExpression): string | null | undefined {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'assetPath') return undefined
  if (node.arguments.length === 0) return '<install-root>'
  const segments: string[] = []
  for (const argument of node.arguments) {
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      segments.push(argument.text)
    } else if (ts.isIdentifier(argument) && argument.text === 'PLATFORM_SLUG') {
      segments.push(PLATFORM_SLUG)
    } else {
      return null
    }
  }
  return segments.join('/')
}

function shipped(path: string): boolean {
  return (
    runtimePaths.has(path) ||
    EMBEDDED_ASSET_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ||
    CHECKOUT_ONLY_RUNTIME_PATHS.has(path)
  )
}

/** Find statically resolvable assetPath calls outside the release manifest. */
export function runtimeAssetCallFindings(sourceText: string, path: string): RuntimeAssetFinding[] {
  if (ignored(path)) return []
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true)
  const findings: RuntimeAssetFinding[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const asset = staticAssetPath(node)
      if (
        (asset === null && !DYNAMIC_ASSET_PATH_ALLOWANCES.has(path)) ||
        (asset !== null && asset !== undefined && !shipped(asset))
      ) {
        findings.push({
          path,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          asset: asset ?? '<dynamic assetPath>',
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

/** Find Python and shell hook reads that escape the shipped hook directory. */
export function hookRuntimeOpenFindings(sourceText: string, path: string): RuntimeAssetFinding[] {
  if (path.includes('/test_') || CHECKOUT_ONLY_HOOKS.has(path)) return []
  const findings: RuntimeAssetFinding[] = []
  const patterns = [
    /parents\[2\]\s*\/\s*["']shared["']\s*\/\s*["']([^"']+)["']/g,
    /os\.path\.join\([^\n]*["']shared["']\s*,\s*["']([^"']+)["']/g,
    /\$ROOT\/\.\.\/shared\/([A-Za-z0-9._/-]+)/g,
  ]
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const asset = `shared/${match[1]}`
      if (!runtimePaths.has(asset)) {
        findings.push({ path, line: sourceText.slice(0, match.index).split('\n').length, asset })
      }
    }
  }
  return findings
}

export type HookAssetFact = { path: string; executable: boolean }

/** Read the production hook inventory and executable bits from a checkout. */
export function hookAssetFacts(repositoryRoot: string = root): HookAssetFact[] {
  const hookRoot = join(repositoryRoot, 'orchestrator/hooks')
  return files(hookRoot).flatMap((diskPath) => {
    const path = relative(repositoryRoot, diskPath).split('\\').join('/')
    if (/\/test_[^/]*\.py$/.test(path) || path.includes('/__pycache__/')) return []
    return [{ path, executable: (statSync(diskPath).mode & 0o111) !== 0 }]
  })
}

/** Find hook files missing a declaration, declared twice, or carrying the wrong executable bit. */
export function hookAssetDeclarationFindings(
  facts: readonly HookAssetFact[],
): RuntimeAssetFinding[] {
  return facts.flatMap((fact) => {
    const runtime = RUNTIME_ASSETS.find((asset) => asset.packagePath === fact.path)
    const checkoutOnly = CHECKOUT_ONLY_HOOKS.has(fact.path)
    if (Boolean(runtime) === checkoutOnly) {
      return [
        { path: fact.path, line: 1, asset: runtime ? '<declared twice>' : '<undeclared hook>' },
      ]
    }
    if (runtime && (runtime.mode === 0o755) !== fact.executable) {
      return [
        {
          path: fact.path,
          line: 1,
          asset: `<mode ${runtime.mode.toString(8)} disagrees with checkout executable bit>`,
        },
      ]
    }
    return []
  })
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

if (import.meta.main) {
  const findings = hookAssetDeclarationFindings(hookAssetFacts()).concat(
    files(root).flatMap((diskPath) => {
      const path = relative(root, diskPath).split('\\').join('/')
      if (/\.(?:ts|tsx|mts)$/.test(path))
        return runtimeAssetCallFindings(readFileSync(diskPath, 'utf8'), path)
      if (path.startsWith('orchestrator/hooks/') && /\.(?:py|sh)$/.test(path)) {
        return hookRuntimeOpenFindings(readFileSync(diskPath, 'utf8'), path)
      }
      return []
    }),
  )
  for (const finding of findings) {
    console.error(
      `${finding.path}:${finding.line}: runtime asset ${finding.asset} is neither embedded nor declared checkout-only with a reason`,
    )
  }
  if (findings.length) process.exit(1)
}
