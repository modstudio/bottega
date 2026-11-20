/** Refuse install-root and hook runtime paths that a compiled release does not ship. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { RUNTIME_ASSETS } from '../shared/embedded-assets.ts'

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

const embeddedPrefixes = [
  'orchestrator/migrations',
  'hub/migrations',
  'hub/web/dist',
  'ops/launchd',
  'ops/systemd',
]

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
    embeddedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ||
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
  if (path.includes('/test_') || path.endsWith('process_heartbeat_shell.py')) return []
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

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

if (import.meta.main) {
  const findings = files(root).flatMap((diskPath) => {
    const path = relative(root, diskPath).split('\\').join('/')
    if (/\.(?:ts|tsx|mts)$/.test(path))
      return runtimeAssetCallFindings(readFileSync(diskPath, 'utf8'), path)
    if (path.startsWith('orchestrator/hooks/') && /\.(?:py|sh)$/.test(path)) {
      return hookRuntimeOpenFindings(readFileSync(diskPath, 'utf8'), path)
    }
    return []
  })
  for (const finding of findings) {
    console.error(
      `${finding.path}:${finding.line}: runtime asset ${finding.asset} is neither embedded nor declared checkout-only with a reason`,
    )
  }
  if (findings.length) process.exit(1)
}
