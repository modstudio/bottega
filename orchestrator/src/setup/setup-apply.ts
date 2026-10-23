// concern: setup-apply
/** Applies planned project actions in order through the project register service boundary. */

import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { removableLegacyPathTarget } from './setup-legacy-path.ts'
import {
  commandFailureReason,
  mcpAddArgv,
  mcpRemoveArgv,
  readMcpRegistration,
  runSetupCommand,
  SETUP_COMMAND_TIMEOUT_MS,
  type SetupCommandRunner,
  sameMcpRegistration,
  screenedMcpField,
} from './setup-mcp.ts'
import { migrateMcpConfigText } from './setup-mcp-config.ts'
import type { SetupAction } from './setup-planner.ts'

type AddAction = Extract<SetupAction, { kind: 'add' }>
type SetAction = Extract<SetupAction, { kind: 'set' }>
type RegistrationAction = Extract<SetupAction, { kind: 'register-mcp' }>
type LegacySymlinkAction = Extract<SetupAction, { kind: 'remove-legacy-symlink' }>

export type SetupActionResult = SetupAction & {
  status: 'applied' | 'unchanged' | 'refused' | 'not-attempted'
  message: string | null
}

export type SetupProjectService = {
  add(input: {
    path: string
    name: string
    stack: string | null
    canon: boolean
    settings: AddAction['settings']
    allowIncomplete: boolean
  }): Promise<unknown>
  fillAbsent(input: { name: string; fill: SetAction['fill'] }): Promise<unknown>
  currentRecipePath?(name: string): string | null
}

export type SetupEnvironmentService = {
  migrateEnvironment(): Promise<string | null>
}

type CreatedRecipe = { path: string; device: number; inode: number; contentHash: string }

const contentHash = (content: string | Uint8Array): string =>
  new Bun.CryptoHasher('sha256').update(content).digest('hex')

function rendered(argv: string[]): string {
  return argv.map((part) => JSON.stringify(part)).join(' ')
}

function isBeneath(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
}

async function ensureRecipeParent(root: string, parent: string): Promise<void> {
  const offset = relative(root, parent)
  if (!isBeneath(root, parent)) {
    throw new Error(`refusing worktree recipe path outside repository ${root}`)
  }
  let current = root
  for (const component of offset.split(sep).filter(Boolean)) {
    current = resolve(current, component)
    await ensureRecipeDirectory(current)
  }
}

async function ensureRecipeDirectory(path: string): Promise<void> {
  let state: Awaited<ReturnType<typeof lstat>>
  try {
    state = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await mkdir(path)
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
    }
    state = await lstat(path)
  }
  if (state.isSymbolicLink()) {
    throw new Error(`refusing worktree recipe path: ${path} is a symbolic link`)
  }
  if (!state.isDirectory()) {
    throw new Error(`refusing worktree recipe path: ${path} is not a directory`)
  }
}

async function writeRecipe(action: AddAction | SetAction): Promise<CreatedRecipe | null> {
  if (!action.recipeFile) return null
  const root = await realpath(action.path)
  const path = resolve(root, action.recipeFile.path)
  if (!isBeneath(root, path)) {
    throw new Error(`refusing worktree recipe path outside repository ${root}`)
  }
  const parent = dirname(path)
  await ensureRecipeParent(root, parent)
  const canonicalParent = await realpath(parent)
  if (!isBeneath(root, canonicalParent)) {
    throw new Error(`refusing worktree recipe parent outside repository ${root}`)
  }
  try {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(action.recipeFile.content, 'utf8')
      const state = await handle.stat()
      return {
        path,
        device: state.dev,
        inode: state.ino,
        contentHash: contentHash(action.recipeFile.content),
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `refusing to overwrite worktree recipe ${path}; re-run ${PLATFORM_SLUG} machine setup plan`,
      )
    }
    throw error
  }
}

export function applyMcpRegistration(
  action: RegistrationAction,
  runner: SetupCommandRunner = runSetupCommand,
): 'applied' | 'unchanged' {
  if (!action.replace && guardRegistrationAdd(action, runner)) return 'unchanged'
  if (action.legacyName) removeMcpRegistration(action, action.legacyName, runner)
  else if (action.harness === 'claude' && action.replace)
    removeMcpRegistration(action, action.server.name, runner)
  const addArgv = mcpAddArgv(action.harness, action.bin, action.server)
  runRegistrationCommand(action.harness, addArgv, runner)
  const readback = readMcpRegistration(action.harness, action.bin, action.server.name, runner)
  if (!sameMcpRegistration(readback, action.server))
    throw new Error(
      `${action.harness} did not verify ${rendered(addArgv)} after add: ${readbackMismatch(readback, action.server)}`,
    )
  return 'applied'
}

function guardRegistrationAdd(action: RegistrationAction, runner: SetupCommandRunner): boolean {
  const current = readMcpRegistration(action.harness, action.bin, action.server.name, runner)
  if (sameMcpRegistration(current, action.server)) return true
  if (current.status === 'absent') return false
  const detail =
    current.status === 'registered' ? mismatchReason(current, action.server) : current.detail
  throw new Error(
    `${action.harness} ${action.server.name} changed before add (${detail}); run ${PLATFORM_SLUG} machine setup apply to review and replace it`,
  )
}

function removeMcpRegistration(
  action: RegistrationAction,
  name: Parameters<typeof mcpRemoveArgv>[2],
  runner: SetupCommandRunner,
): void {
  const removeArgv = mcpRemoveArgv(action.harness, action.bin, name)
  runRegistrationCommand(action.harness, removeArgv, runner)
}

function runRegistrationCommand(
  harness: RegistrationAction['harness'],
  argv: string[],
  runner: SetupCommandRunner,
): void {
  const result = runner(argv, SETUP_COMMAND_TIMEOUT_MS)
  if (result.exitCode !== 0 || result.timedOut || result.error)
    throw new Error(`${harness} refused ${rendered(argv)}: ${commandFailureReason(result)}`)
}

function readbackMismatch(
  readback: ReturnType<typeof readMcpRegistration>,
  server: RegistrationAction['server'],
): string {
  if (readback.status === 'registered') return mismatchReason(readback, server)
  if (readback.status === 'unreadable') return readback.detail
  return 'registration absent after add'
}

function mismatchReason(
  found: { command: string; args: string[] },
  expected: { command: string; args: string[] },
): string {
  const fields: string[] = []
  if (found.command !== expected.command)
    fields.push(
      `command expected ${screenedMcpField(expected.command)} found ${screenedMcpField(found.command)}`,
    )
  if (JSON.stringify(found.args) !== JSON.stringify(expected.args))
    fields.push(
      `args expected ${screenedMcpField(expected.args)} found ${screenedMcpField(found.args)}`,
    )
  return `mismatched ${fields.join('; ')}`
}

export async function applySetupActions(
  actions: SetupAction[],
  service: SetupProjectService,
  environment: SetupEnvironmentService,
  runner: SetupCommandRunner = runSetupCommand,
): Promise<SetupActionResult[]> {
  const results: SetupActionResult[] = []
  let refused = false
  for (const action of actions) {
    if (refused) {
      results.push({ ...action, status: 'not-attempted', message: null })
      continue
    }
    try {
      const applied = await applySetupAction(action, service, environment, runner)
      results.push({ ...action, ...applied })
    } catch (error) {
      refused = true
      results.push({
        ...action,
        status: 'refused',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

async function applySetupAction(
  action: SetupAction,
  service: SetupProjectService,
  environment: SetupEnvironmentService,
  runner: SetupCommandRunner,
): Promise<{ status: 'applied' | 'unchanged'; message: string | null }> {
  if (action.kind === 'migrate-environment') {
    const message = await environment.migrateEnvironment()
    return { status: message ? 'applied' : 'unchanged', message }
  }
  if (
    action.kind === 'unchanged' ||
    action.kind === 'mcp-unchanged' ||
    action.kind === 'mcp-skipped'
  ) {
    return { status: 'unchanged', message: null }
  }
  if (action.kind === 'migrate-mcp-config') {
    const current = await readFile(action.path, 'utf8')
    const migrated = migrateMcpConfigText(current, {
      renameServerKeys: basename(action.path) !== '.claude.json',
    })
    if (current === migrated) return { status: 'unchanged', message: null }
    await writeFile(action.path, migrated, 'utf8')
    return { status: 'applied', message: null }
  }
  if (action.kind === 'remove-legacy-symlink')
    return { status: await applyLegacyPathSymlinkRemoval(action), message: null }
  if (action.kind === 'register-mcp')
    return { status: applyMcpRegistration(action, runner), message: null }
  if (action.kind === 'add') {
    await applyAddAction(action, service)
    return { status: 'applied', message: null }
  }
  if (action.kind === 'set') {
    await applySetAction(action, service)
    return { status: 'applied', message: null }
  }
  return { status: 'unchanged', message: null }
}

async function applyLegacyPathSymlinkRemoval(
  action: LegacySymlinkAction,
): Promise<'applied' | 'unchanged'> {
  try {
    await lstat(action.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'unchanged'
    throw error
  }
  const target = removableLegacyPathTarget(action.path)
  if (target === null) {
    throw new Error(
      `refusing to remove ${action.path}: it is not a removable leftover PATH symlink; leave it or remove it by hand if you own it, then re-run ${PLATFORM_SLUG} machine setup plan`,
    )
  }
  if (target !== action.target) {
    throw new Error(
      `refusing to remove ${action.path}: it now points at ${target}; re-run ${PLATFORM_SLUG} machine setup plan and apply the new plan`,
    )
  }
  await rm(action.path)
  return 'applied'
}

async function applyAddAction(action: AddAction, service: SetupProjectService): Promise<void> {
  const createdRecipe = await writeRecipe(action)
  try {
    await service.add({
      path: action.path,
      name: action.name,
      stack: action.stack,
      canon: true,
      settings: action.settings,
      allowIncomplete: false,
    })
  } catch (error) {
    await compensateRecipe(error, createdRecipe)
  }
}

async function applySetAction(action: SetAction, service: SetupProjectService): Promise<void> {
  const createdRecipe = await writeRecipe(action)
  try {
    await service.fillAbsent({ name: action.currentName, fill: action.fill })
  } catch (error) {
    const currentRecipePath = service.currentRecipePath?.(action.currentName)
    const requestedRecipePath = action.fill.settings.worktree?.recipePath
    if (requestedRecipePath && currentRecipePath === requestedRecipePath) {
      throw new Error(
        `hosted write failed after recipePath was committed locally; recipe file was kept: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await compensateRecipe(error, createdRecipe)
  }
}

async function compensateRecipe(
  error: unknown,
  createdRecipe: CreatedRecipe | null,
): Promise<never> {
  if (!createdRecipe) throw error
  try {
    const state = await lstat(createdRecipe.path)
    const hash = state.isFile() ? contentHash(await readFile(createdRecipe.path)) : null
    const stillOurs =
      state.dev === createdRecipe.device &&
      state.ino === createdRecipe.inode &&
      hash === createdRecipe.contentHash
    if (!stillOurs) {
      throw new Error('file identity or content changed after creation; left it in place')
    }
    await rm(createdRecipe.path)
  } catch (cleanupError) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; could not remove recipe created by this apply at ${createdRecipe.path}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    )
  }
  throw error
}
