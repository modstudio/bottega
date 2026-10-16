#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import {
  HUB_PACKAGE_PREFIX,
  HUB_UI_PACKAGE,
  HUB_UI_ROOT,
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
const expectedExports = Object.fromEntries(
  [...new Glob('**/*.{ts,tsx,css}').scanSync({ cwd: join(ROOT, HUB_UI_ROOT, 'src') })]
    .filter((path) => !/\.(?:test|spec)\.[cm]?tsx?$/.test(path))
    .map((path) => [exportSubpath(path), `./src/${path.split(sep).join('/')}`])
    .sort(([left], [right]) => left.localeCompare(right)),
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

if (violations.length) {
  for (const violation of violations) console.error(violation)
  process.exit(1)
}

console.log(
  `check-hub-packages: ok (${checkedPackages.sort().join(', ')}; ${Object.keys(expectedExports).length} ui exports)`,
)
