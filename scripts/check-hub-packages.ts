#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import {
  HUB_DATA_PACKAGE,
  HUB_DATA_ROOT,
  HUB_PACKAGE_PREFIX,
  HUB_SITE_PACKAGE,
  HUB_SITE_ROOT,
  HUB_UI_PACKAGE,
  HUB_UI_ROOT,
  HUB_UTIL_PACKAGE,
  HUB_UTIL_ROOT,
  HUB_VIEWS_PACKAGE,
  HUB_VIEWS_ROOT,
  hubUtilRuntimeDependencyViolations,
  hubWebSourcePlacementViolation,
  hubWorkspaceDependencies,
} from './architecture-hub-packages.ts'
import { isDeclaredHubUiSourceLocation } from './architecture-ui-layers.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]
const violations: string[] = []

for (const sourcePath of new Glob('**/*').scanSync({ cwd: join(ROOT, 'hub/web/src') })) {
  const violation = hubWebSourcePlacementViolation(`hub/web/src/${sourcePath.split(sep).join('/')}`)
  if (violation) violations.push(violation)
}

type PackageJson = {
  name?: string
  exports?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

function readPackage(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
}

const rootPackage = readPackage(join(ROOT, 'package.json')) as PackageJson & {
  workspaces?: string[]
}
const workspacePackagePaths = [
  ...new Set(
    (rootPackage.workspaces ?? []).flatMap((workspace) =>
      [...new Glob(`${workspace}/package.json`).scanSync({ cwd: ROOT })].map((path) =>
        path.split(sep).join('/'),
      ),
    ),
  ),
].sort()
const workspaceNames = new Set(
  workspacePackagePaths
    .map((path) => readPackage(join(ROOT, path)).name)
    .filter((name): name is string => name !== undefined),
)

const checkedPackages: string[] = []
for (const relativePath of workspacePackagePaths) {
  const packageJson = readPackage(join(ROOT, relativePath))
  if (!packageJson.name?.startsWith(HUB_PACKAGE_PREFIX)) continue
  checkedPackages.push(packageJson.name)
  if (!(packageJson.name in hubWorkspaceDependencies)) {
    violations.push(`${relativePath}: ${packageJson.name} is missing from hubWorkspaceDependencies`)
    continue
  }
  const allowed = new Set<string>(hubWorkspaceDependencies[packageJson.name] ?? [])
  for (const field of dependencyFields) {
    const dependencies = packageJson[field as keyof PackageJson]
    if (!dependencies || typeof dependencies !== 'object') continue
    for (const dependency of Object.keys(dependencies)) {
      if (workspaceNames.has(dependency) && !allowed.has(dependency)) {
        violations.push(
          `${relativePath}: ${packageJson.name} may not depend on workspace package ${dependency}`,
        )
      }
    }
  }
}

for (const sourcePath of new Glob('**/*.{ts,tsx,css}').scanSync({
  cwd: join(ROOT, HUB_UI_ROOT, 'src'),
})) {
  const repositoryPath = `${HUB_UI_ROOT}/src/${sourcePath.split(sep).join('/')}`
  if (!isDeclaredHubUiSourceLocation(repositoryPath)) {
    violations.push(`${repositoryPath}: source file is not in a declared hub-ui layer folder`)
  }
}

function exportSubpath(sourcePath: string) {
  const normalized = sourcePath.split(sep).join('/')
  if (normalized === 'styles/tokens.css' || normalized === 'styles/theme.css') {
    return `./${normalized}`
  }
  const extension = extname(normalized)
  const withoutExtension = normalized.slice(0, -extension.length)
  const parts = withoutExtension.split('/')
  const file = parts.at(-1)
  const folder = parts.at(-2)
  return file === folder ? `./${parts.slice(0, -1).join('/')}` : `./${withoutExtension}`
}

const uiPackagePath = join(ROOT, HUB_UI_ROOT, 'package.json')
const uiPackage = readPackage(uiPackagePath)
const exportSources = new Map<string, string[]>()
for (const path of new Glob('**/*.{ts,tsx,css}').scanSync({
  cwd: join(ROOT, HUB_UI_ROOT, 'src'),
})) {
  if (/\.(?:test|spec|stories)\.[cm]?tsx?$/.test(path)) continue
  const normalized = path.split(sep).join('/')
  const subpath = exportSubpath(normalized)
  const sources = exportSources.get(subpath) ?? []
  sources.push(`${HUB_UI_ROOT}/src/${normalized}`)
  exportSources.set(subpath, sources)
}
for (const [subpath, sources] of exportSources) {
  if (sources.length > 1) {
    violations.push(
      `${relative(ROOT, uiPackagePath)}: export ${subpath} is derived from ${sources.join(' and ')}`,
    )
  }
}
const expectedExports = Object.fromEntries(
  [...exportSources.entries()]
    .map(([subpath, sources]) => [
      subpath,
      `./src/${sources[0]!.slice(`${HUB_UI_ROOT}/src/`.length)}`,
    ])
    .sort(([left], [right]) => left!.localeCompare(right!)),
)
const actualExports = uiPackage.exports ?? {}
for (const [subpath, source] of Object.entries(expectedExports)) {
  if (actualExports[subpath] !== source) {
    violations.push(`${relative(ROOT, uiPackagePath)}: export ${subpath} must point to ${source}`)
  }
}
for (const subpath of Object.keys(actualExports)) {
  if (!(subpath in expectedExports)) {
    violations.push(`${relative(ROOT, uiPackagePath)}: export ${subpath} has no public source file`)
  }
}

if (uiPackage.name !== HUB_UI_PACKAGE) {
  violations.push(`${relative(ROOT, uiPackagePath)}: package name must be ${HUB_UI_PACKAGE}`)
}

const viewsPackagePath = join(ROOT, HUB_VIEWS_ROOT, 'package.json')
const viewsPackage = readPackage(viewsPackagePath)
const viewExportSources = new Map<string, string[]>()
for (const path of new Glob('**/*.{ts,tsx,css}').scanSync({
  cwd: join(ROOT, HUB_VIEWS_ROOT, 'src'),
})) {
  if (/\.(?:test|spec|stories)\.[cm]?tsx?$/.test(path)) continue
  const normalized = path.split(sep).join('/')
  const subpath = exportSubpath(normalized)
  const sources = viewExportSources.get(subpath) ?? []
  sources.push(`${HUB_VIEWS_ROOT}/src/${normalized}`)
  viewExportSources.set(subpath, sources)
}
for (const [subpath, sources] of viewExportSources) {
  if (sources.length > 1) {
    violations.push(
      `${relative(ROOT, viewsPackagePath)}: export ${subpath} is derived from ${sources.join(' and ')}`,
    )
  }
}
const expectedViewExports = Object.fromEntries(
  [...viewExportSources.entries()]
    .map(([subpath, sources]) => [
      subpath,
      `./src/${sources[0]!.slice(`${HUB_VIEWS_ROOT}/src/`.length)}`,
    ])
    .sort(([left], [right]) => left!.localeCompare(right!)),
)
const actualViewExports = viewsPackage.exports ?? {}
for (const [subpath, source] of Object.entries(expectedViewExports)) {
  if (actualViewExports[subpath] !== source) {
    violations.push(
      `${relative(ROOT, viewsPackagePath)}: export ${subpath} must point to ${source}`,
    )
  }
}
for (const subpath of Object.keys(actualViewExports)) {
  if (!(subpath in expectedViewExports)) {
    violations.push(
      `${relative(ROOT, viewsPackagePath)}: export ${subpath} has no public source file`,
    )
  }
}
if (viewsPackage.name !== HUB_VIEWS_PACKAGE) {
  violations.push(`${relative(ROOT, viewsPackagePath)}: package name must be ${HUB_VIEWS_PACKAGE}`)
}

const dataPackagePath = join(ROOT, HUB_DATA_ROOT, 'package.json')
const dataPackage = readPackage(dataPackagePath)
const expectedDataExports = Object.fromEntries(
  [...new Glob('**/*.{ts,tsx}').scanSync({ cwd: join(ROOT, HUB_DATA_ROOT, 'src') })]
    .filter((path) => !/\.(?:test|spec)\.[cm]?tsx?$/.test(path))
    .map((path) => {
      const normalized = path.split(sep).join('/')
      return [exportSubpath(normalized), `./src/${normalized}`]
    })
    .sort(([left], [right]) => left!.localeCompare(right!)),
)
for (const [subpath, source] of Object.entries(expectedDataExports)) {
  if (dataPackage.exports?.[subpath] !== source) {
    violations.push(`${relative(ROOT, dataPackagePath)}: export ${subpath} must point to ${source}`)
  }
}
for (const subpath of Object.keys(dataPackage.exports ?? {})) {
  if (!(subpath in expectedDataExports)) {
    violations.push(
      `${relative(ROOT, dataPackagePath)}: export ${subpath} has no public source file`,
    )
  }
}
if (dataPackage.name !== HUB_DATA_PACKAGE) {
  violations.push(`${relative(ROOT, dataPackagePath)}: package name must be ${HUB_DATA_PACKAGE}`)
}

const utilPackagePath = join(ROOT, HUB_UTIL_ROOT, 'package.json')
const utilPackage = readPackage(utilPackagePath)
const expectedUtilExports = Object.fromEntries(
  [...new Glob('**/*.{ts,tsx}').scanSync({ cwd: join(ROOT, HUB_UTIL_ROOT, 'src') })]
    .filter((path) => !/\.(?:test|spec)\.[cm]?tsx?$/.test(path))
    .map((path) => {
      const normalized = path.split(sep).join('/')
      return [exportSubpath(normalized), `./src/${normalized}`]
    })
    .sort(([left], [right]) => left!.localeCompare(right!)),
)
for (const [subpath, source] of Object.entries(expectedUtilExports)) {
  if (utilPackage.exports?.[subpath] !== source) {
    violations.push(`${relative(ROOT, utilPackagePath)}: export ${subpath} must point to ${source}`)
  }
}
for (const subpath of Object.keys(utilPackage.exports ?? {})) {
  if (!(subpath in expectedUtilExports)) {
    violations.push(
      `${relative(ROOT, utilPackagePath)}: export ${subpath} has no public source file`,
    )
  }
}
if (utilPackage.name !== HUB_UTIL_PACKAGE) {
  violations.push(`${relative(ROOT, utilPackagePath)}: package name must be ${HUB_UTIL_PACKAGE}`)
}
violations.push(...hubUtilRuntimeDependencyViolations(utilPackage))

const sitePackagePath = join(ROOT, HUB_SITE_ROOT, 'package.json')
const sitePackage = readPackage(sitePackagePath)
const expectedSiteExports = Object.fromEntries(
  [...new Glob('**/*.{ts,tsx,css}').scanSync({ cwd: join(ROOT, HUB_SITE_ROOT, 'src') })]
    .filter((path) => !/\.(?:test|spec)\.[cm]?tsx?$/.test(path))
    .map((path) => {
      const normalized = path.split(sep).join('/')
      return [exportSubpath(normalized), `./src/${normalized}`]
    })
    .sort(([left], [right]) => left!.localeCompare(right!)),
)
for (const [subpath, source] of Object.entries(expectedSiteExports)) {
  if (sitePackage.exports?.[subpath] !== source) {
    violations.push(`${relative(ROOT, sitePackagePath)}: export ${subpath} must point to ${source}`)
  }
}
for (const subpath of Object.keys(sitePackage.exports ?? {})) {
  if (!(subpath in expectedSiteExports)) {
    violations.push(
      `${relative(ROOT, sitePackagePath)}: export ${subpath} has no public source file`,
    )
  }
}
if (sitePackage.name !== HUB_SITE_PACKAGE) {
  violations.push(`${relative(ROOT, sitePackagePath)}: package name must be ${HUB_SITE_PACKAGE}`)
}

if (violations.length) {
  for (const violation of violations) console.error(violation)
  process.exit(1)
}

console.log(
  `check-hub-packages: ok (${checkedPackages.sort().join(', ')}; ${Object.keys(expectedExports).length} ui exports; ${Object.keys(expectedDataExports).length} data exports; ${Object.keys(expectedSiteExports).length} site exports; ${Object.keys(expectedUtilExports).length} util exports)`,
)
