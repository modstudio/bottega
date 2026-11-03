/**
 * Refuse production filesystem paths derived directly from a module location.
 * Tests, fixtures, scripts, build-tool *.config.ts/*.config.mts files, and .storybook are excluded.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { LAUNCHD_TEMPLATE_OWNERS } from '../orchestrator/src/setup/launchd-owners.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const REMEDY_BASELINE_PATH = join(root, 'scripts', 'install-path-remedy-baseline.json')

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
export type InstallPathRemedyBaseline = { files: Record<string, number> }

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

const CHECKOUT_ONLY_INSTALLERS = LAUNCHD_TEMPLATE_OWNERS.map(({ command }) => command)

function isLaunchdOwnerCommandDeclaration(node: ts.Node, path: string): boolean {
  if (path !== 'orchestrator/src/setup/launchd-owners.ts') return false
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.name.text === 'LAUNCHD_TEMPLATE_OWNERS'
    ) {
      return true
    }
  }
  return false
}

function isRunningRootBinJoin(node: ts.CallExpression): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'join') return false
  const [base, bin, slug] = node.arguments
  if (
    !base ||
    !bin ||
    !slug ||
    !ts.isStringLiteral(bin) ||
    bin.text !== 'bin' ||
    !ts.isIdentifier(slug) ||
    slug.text !== 'PLATFORM_SLUG'
  ) {
    return false
  }
  return true
}

function isAssetPathBinCall(node: ts.CallExpression): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'assetPath') return false
  const [bin, slug] = node.arguments
  return (
    !!bin &&
    !!slug &&
    ts.isStringLiteral(bin) &&
    bin.text === 'bin' &&
    ts.isIdentifier(slug) &&
    slug.text === 'PLATFORM_SLUG'
  )
}

function isRemedyFindingExemption(node: ts.Node, path: string): boolean {
  if (path === 'shared/self-spawn.ts') return true
  if (path !== 'shared/install-root.ts') return false
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name?.text === 'resolveInstallationPaths') {
      return true
    }
  }
  return false
}

function templateNamesPlatformBin(node: ts.TemplateExpression): boolean {
  return node.templateSpans.some((span, index) => {
    const precedingText = index === 0 ? node.head.text : node.templateSpans[index - 1]!.literal.text
    return (
      precedingText.endsWith('bin/') &&
      ts.isIdentifier(span.expression) &&
      span.expression.text === 'PLATFORM_SLUG'
    )
  })
}

/** Return remedies that can name checkout-only paths while running from a distribution. */
export function distributionUnsafeInstallPathFindings(
  sourceText: string,
  path: string,
): InstallPathFinding[] {
  if (ignoredPath(path)) return []
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true)
  const findings: InstallPathFinding[] = []
  const visit = (node: ts.Node): void => {
    if (isRemedyFindingExemption(node, path)) return
    const literalText =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateExpression(node)
          ? node.getText(source)
          : null
    const checkoutInstaller =
      literalText !== null &&
      CHECKOUT_ONLY_INSTALLERS.some((command) => literalText.includes(command)) &&
      !isLaunchdOwnerCommandDeclaration(node, path)
    if (
      checkoutInstaller ||
      (ts.isTemplateExpression(node) && templateNamesPlatformBin(node)) ||
      (ts.isCallExpression(node) && (isRunningRootBinJoin(node) || isAssetPathBinCall(node)))
    ) {
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

export function installPathRemedyViolations(
  findings: readonly InstallPathFinding[],
  baseline: InstallPathRemedyBaseline,
): string[] {
  const counts = new Map<string, number>()
  for (const finding of findings) counts.set(finding.path, (counts.get(finding.path) ?? 0) + 1)
  const violations: string[] = []
  for (const [path, count] of counts) {
    const allowed = baseline.files[path] ?? 0
    if (count > allowed) {
      violations.push(
        `${path}: distribution-unsafe install remedy count grew from ${allowed} to ${count}`,
      )
    }
  }
  for (const [path, allowed] of Object.entries(baseline.files)) {
    const count = counts.get(path) ?? 0
    if (count < allowed) {
      violations.push(
        `${path}: distribution-unsafe install remedy baseline may only shrink; lower its count from ${allowed} to ${count}`,
      )
    }
  }
  return violations
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

function findingsInProductionSources(
  finder: (sourceText: string, repositoryPath: string) => InstallPathFinding[],
): InstallPathFinding[] {
  return productionSources(root).flatMap((path) => {
    const repositoryPath = relative(root, path).split('\\').join('/')
    return finder(readFileSync(path, 'utf8'), repositoryPath)
  })
}

function checkInstallPaths(): InstallPathFinding[] {
  return findingsInProductionSources(installPathFindings)
}

function checkDistributionRemedies(): InstallPathFinding[] {
  return findingsInProductionSources(distributionUnsafeInstallPathFindings)
}

if (import.meta.main) {
  const findings = checkInstallPaths()
  for (const finding of findings) {
    console.error(
      `${finding.path}:${finding.line}: production paths must not be built from a module location; read through readInstallAsset or an install-root resolver, and add any new install-aware resolver to INSTALL_AWARE_RESOLVERS in scripts/check-install-paths.ts`,
    )
  }
  const remedyFindings = checkDistributionRemedies()
  const remedyBaseline = JSON.parse(
    readFileSync(REMEDY_BASELINE_PATH, 'utf8'),
  ) as InstallPathRemedyBaseline
  const remedyViolations = installPathRemedyViolations(remedyFindings, remedyBaseline)
  for (const violation of remedyViolations) console.error(violation)
  if (findings.length || remedyViolations.length) process.exit(1)
}
