// concern: setup-repository-toolchain
/** Reads repository declarations without executing project code or installing dependencies. */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { detect } from 'package-manager-detector'
import { DEFAULT_PROJECT_CONFIG_PATH } from '../worktree/worktree-lifecycle.ts'
import {
  type DetectedPackageManager,
  INFERRED_RECIPE_PATH,
  type ToolchainFacts,
} from './setup-toolchain.ts'

const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
const has = (root: string, name: string) => existsSync(join(root, name))
const command = (manager: DetectedPackageManager, script: string) =>
  manager === 'bun'
    ? `bun run ${script}`
    : manager === 'npm'
      ? `npm run ${script}`
      : manager === 'pnpm' || manager === 'yarn'
        ? `${manager} ${script}`
        : ''

function requirements(root: string): string[] {
  try {
    return readdirSync(root).filter((name) => /^requirements.*\.txt$/i.test(name))
  } catch {
    return []
  }
}

function ciFiles(root: string): string[] {
  const files = ['.gitlab-ci.yml', '.circleci/config.yml'].filter((name) => has(root, name))
  try {
    files.push(
      ...readdirSync(join(root, '.github/workflows')).map((name) => `.github/workflows/${name}`),
    )
  } catch {
    // No GitHub workflows directory.
  }
  return files
}

async function packageManager(root: string): Promise<DetectedPackageManager | null> {
  if (has(root, 'composer.lock') || has(root, 'composer.json')) return 'composer'
  if (has(root, 'Gemfile.lock')) return 'bundler'
  if (has(root, 'uv.lock')) return 'uv'
  if (has(root, 'poetry.lock')) return 'poetry'
  if (requirements(root).length) return 'pip'
  if (has(root, 'go.mod')) return 'go'
  if (has(root, 'Cargo.toml')) return 'cargo'
  if (!has(root, 'package.json')) return null
  const found = await detect({ cwd: root, stopDir: root })
  return found && ['bun', 'npm', 'pnpm', 'yarn'].includes(found.name)
    ? (found.name as DetectedPackageManager)
    : null
}

function scripts(source: string): Record<string, unknown> {
  try {
    const value = JSON.parse(source) as { scripts?: unknown }
    return value.scripts && typeof value.scripts === 'object'
      ? (value.scripts as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function makeTargets(source: string): Set<string> {
  return new Set([...source.matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((match) => match[1]!))
}

type Commands = Pick<ToolchainFacts, 'lint' | 'typecheck' | 'test'>
const noCommands = (): Commands => ({ lint: null, typecheck: null, test: null })

function javascriptCommands(root: string, manager: DetectedPackageManager): Commands {
  const commands = noCommands()
  const value = scripts(read(join(root, 'package.json')))
  if (typeof value.lint === 'string') commands.lint = command(manager, 'lint')
  const typeScript =
    typeof value.typecheck === 'string'
      ? 'typecheck'
      : typeof value['type-check'] === 'string'
        ? 'type-check'
        : null
  if (typeScript) commands.typecheck = command(manager, typeScript)
  if (
    typeof value.test === 'string' &&
    value.test.trim() !== 'echo "Error: no test specified" && exit 1'
  )
    commands.test = command(manager, 'test')
  return commands
}

function composerCommands(root: string): Commands {
  const value = scripts(read(join(root, 'composer.json')))
  const lintScript = ['lint', 'analyse', 'stan'].find((name) => typeof value[name] === 'string')
  return {
    lint: lintScript ? `composer ${lintScript}` : null,
    typecheck: null,
    test: typeof value.test === 'string' ? 'composer test' : null,
  }
}

function manifestCommands(root: string, manager: DetectedPackageManager | null): Commands {
  if (manager && ['bun', 'npm', 'pnpm', 'yarn'].includes(manager))
    return javascriptCommands(root, manager)
  return manager === 'composer' ? composerCommands(root) : noCommands()
}

function makeCommands(root: string): Commands {
  const targets = makeTargets(read(join(root, 'Makefile')))
  return {
    lint: targets.has('lint') ? 'make lint' : null,
    typecheck: null,
    test: targets.has('test') ? 'make test' : null,
  }
}

function pythonCommands(root: string, manager: 'uv' | 'poetry' | 'pip'): Commands {
  const pyproject = read(join(root, 'pyproject.toml'))
  const prefix = manager === 'uv' ? 'uv run ' : manager === 'poetry' ? 'poetry run ' : ''
  const requirementsText = requirements(root)
    .map((name) => read(join(root, name)))
    .join('\n')
  return {
    lint:
      /^\[tool\.ruff(?:\.[^\]]+)?\]\s*$/m.test(pyproject) || has(root, 'ruff.toml')
        ? `${prefix}ruff check .`
        : null,
    typecheck: null,
    test: /\bpytest\b/i.test(`${pyproject}\n${requirementsText}`) ? `${prefix}pytest` : null,
  }
}

function isBeneath(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

/** Judge one existing path component: a result ends the walk, null continues it. */
function inspectComponent(
  current: string,
  path: string,
): ToolchainFacts['inferredRecipeFile'] | null {
  let state: ReturnType<typeof lstatSync>
  try {
    state = lstatSync(current)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent', content: null, reason: null }
    }
    return { status: 'unsafe', content: null, reason: String(error) }
  }
  if (state.isSymbolicLink()) {
    return { status: 'unsafe', content: null, reason: `${current} is a symbolic link` }
  }
  if (current !== path && !state.isDirectory()) {
    return { status: 'unsafe', content: null, reason: `${current} is not a directory` }
  }
  return null
}

function inspectInferredRecipe(root: string): ToolchainFacts['inferredRecipeFile'] {
  const canonicalRoot = realpathSync(root)
  const path = resolve(canonicalRoot, INFERRED_RECIPE_PATH)
  if (!isBeneath(canonicalRoot, path)) {
    return { status: 'unsafe', content: null, reason: 'path is outside the repository' }
  }
  let current = canonicalRoot
  for (const component of relative(canonicalRoot, path).split(sep).filter(Boolean)) {
    current = resolve(current, component)
    const ended = inspectComponent(current, path)
    if (ended) return ended
  }
  const state = lstatSync(path)
  if (!state.isFile()) {
    return { status: 'unsafe', content: null, reason: `${path} is not a regular file` }
  }
  if (!isBeneath(canonicalRoot, realpathSync(dirname(path)))) {
    return { status: 'unsafe', content: null, reason: 'parent resolves outside the repository' }
  }
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    return { status: 'unsafe', content: null, reason: String(error) }
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      return { status: 'unsafe', content: null, reason: `${path} is not a regular file` }
    }
    return { status: 'regular', content: readFileSync(descriptor, 'utf8'), reason: null }
  } finally {
    closeSync(descriptor)
  }
}

function ecosystemCommands(
  root: string,
  manager: DetectedPackageManager | null,
  ciPaths: string[],
): Commands | null {
  if (manager === 'go') return { lint: 'go vet ./...', typecheck: null, test: 'go test ./...' }
  if (manager !== 'cargo') return null
  const clippy =
    [read(join(root, 'Cargo.toml')), ...ciPaths.map((name) => read(join(root, name)))].some(
      (source) => /clippy/i.test(source),
    ) || has(root, 'clippy.toml')
  return { lint: clippy ? 'cargo clippy' : null, typecheck: null, test: 'cargo test' }
}

export async function detectRepositoryToolchain(root: string): Promise<ToolchainFacts> {
  const manager = await packageManager(root)
  const ciPaths = ciFiles(root)
  const ci = ciPaths.length > 0
  let commands = manifestCommands(root, manager)
  if (!commands.lint && !commands.typecheck && !commands.test) commands = makeCommands(root)
  if (
    !commands.lint &&
    !commands.test &&
    (manager === 'uv' || manager === 'poetry' || manager === 'pip')
  )
    commands = pythonCommands(root, manager)
  commands = ecosystemCommands(root, manager, ciPaths) ?? commands
  return {
    packageManager: manager,
    ...commands,
    ci,
    defaultConfigExists: has(root, DEFAULT_PROJECT_CONFIG_PATH),
    inferredRecipeFile: inspectInferredRecipe(root),
  }
}
