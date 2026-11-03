/** Refuse production filesystem paths derived directly from a module directory. */
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
  'resolveInstallFile',
  'resolveInstallRoot',
  'resolveInstallationPaths',
])

export type InstallPathFinding = { path: string; line: number }

function ignoredPath(path: string): boolean {
  const parts = path.split('/')
  return (
    path.endsWith('.test.ts') ||
    path.endsWith('.test.tsx') ||
    path.endsWith('.fixture.ts') ||
    path.endsWith('.fixture.tsx') ||
    parts.includes('test') ||
    parts.includes('tests') ||
    parts.includes('fixtures') ||
    parts.includes('scripts')
  )
}

function isImportMetaDir(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'dir' &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta'
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

/** Return direct module-directory uses that do not pass through an install-aware resolver. */
export function installPathFindings(sourceText: string, path: string): InstallPathFinding[] {
  if (ignoredPath(path)) return []
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true)
  const findings: InstallPathFinding[] = []
  const visit = (node: ts.Node): void => {
    if (isImportMetaDir(node) && !isInstallAwareArgument(node)) {
      findings.push({
        path,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      })
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
      if (repositoryPath.split('/').includes('scripts')) continue
      paths.push(...productionSources(path))
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
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
      `${finding.path}:${finding.line}: production paths must not be built from import.meta.dir; read through readInstallAsset or an install-root resolver`,
    )
  }
  if (findings.length) process.exit(1)
}
