/**
 * Refuse production filesystem paths derived directly from a module location.
 * Tests, fixtures, scripts, build-tool *.config.ts/*.config.mts files, and .storybook are excluded.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))

const INSTALL_AWARE_RESOLVERS = new Set([
  'embeddedDistributionManifest',
  'installationBuildId',
  'installationIdentity',
  'installationVersionText',
  'isAuthorizedPlatformInstallation',
  'readInstallAsset',
  'optionalCheckoutRoot',
  'requireCheckoutRoot',
  'resolveInstallFile',
  'resolveInstallRoot',
  'resolveInstallationPaths',
  'runningInstallRoot',
])

/** Module identity used for stack-frame attribution, never opened as a filesystem path. */
const INSTALL_PATH_ALLOWANCES = new Map([
  ['hub/src/db.ts\0fileURLToPath(import.meta.url)', 'stack-frame-module-identity'],
])

export type InstallPathFinding = { path: string; line: number }

function ignoredPath(path: string): boolean {
  const parts = path.split('/')
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.fixture.ts') ||
    path.endsWith('.fixture.tsx') ||
    path.endsWith('.config.ts') ||
    path.endsWith('.config.mts') ||
    parts.includes('test') ||
    parts.includes('tests') ||
    parts.includes('fixtures') ||
    parts.includes('.storybook') ||
    parts.includes('scripts')
  )
}

function isImportMetaPath(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ['dir', 'dirname', 'url', 'filename'].includes(node.name.text) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
  )
}

function isModulePath(node: ts.Node): boolean {
  return (
    isImportMetaPath(node) ||
    (ts.isIdentifier(node) && (node.text === '__dirname' || node.text === '__filename'))
  )
}

function isInstallAwareArgument(node: ts.Node): boolean {
  const parent = node.parent
  return (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(node as ts.Expression) &&
    ts.isIdentifier(parent.expression) &&
    INSTALL_AWARE_RESOLVERS.has(parent.expression.text)
  )
}

function allowanceExpression(node: ts.Node, source: ts.SourceFile): string {
  const parent = node.parent
  if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
    const wrapper = parent.parent
    if (
      ((ts.isCallExpression(wrapper) || ts.isNewExpression(wrapper)) &&
        (wrapper.arguments?.includes(parent) ||
          (ts.isCallExpression(wrapper) && wrapper.expression === parent))) ||
      ((ts.isPropertyAccessExpression(wrapper) || ts.isElementAccessExpression(wrapper)) &&
        wrapper.expression === parent)
    ) {
      return node.getText(source)
    }
    return parent.getText(source)
  }
  return node.getText(source)
}

/** Return direct module-location uses that do not pass through an install-aware resolver. */
export function installPathFindings(sourceText: string, path: string): InstallPathFinding[] {
  if (ignoredPath(path)) return []
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true)
  const findings: InstallPathFinding[] = []
  const consumedAllowances = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (isModulePath(node) && !isInstallAwareArgument(node)) {
      const allowance = `${path}\0${allowanceExpression(node, source)}`
      if (INSTALL_PATH_ALLOWANCES.has(allowance) && !consumedAllowances.has(allowance)) {
        consumedAllowances.add(allowance)
      } else {
        findings.push({
          path,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function productionSources(directory: string): string[] {
  const paths: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    const repositoryPath = relative(root, path).split('\\').join('/')
    if (entry.isDirectory()) {
      if (ignoredPath(repositoryPath)) continue
      paths.push(...productionSources(path))
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.mts')) &&
      !ignoredPath(repositoryPath)
    ) {
      paths.push(path)
    }
  }
  return paths
}

function checkInstallPaths(): InstallPathFinding[] {
  return productionSources(root).flatMap((path) => {
    const repositoryPath = relative(root, path).split('\\').join('/')
    return installPathFindings(readFileSync(path, 'utf8'), repositoryPath)
  })
}

if (import.meta.main) {
  const findings = checkInstallPaths()
  for (const finding of findings) {
    console.error(
      `${finding.path}:${finding.line}: production paths must not be built from a module location; read through readInstallAsset or an install-root resolver, and add any new install-aware resolver to INSTALL_AWARE_RESOLVERS in scripts/check-install-paths.ts`,
    )
  }
  if (findings.length) process.exit(1)
}
