// concern: setup-apply
/** Applies planned project actions in order through the project register service boundary. */

import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

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
import type { SetupAction } from './setup-planner.ts'

type AddAction = Extract<SetupAction, { kind: 'add' }>
type SetAction = Extract<SetupAction, { kind: 'set' }>
type RegistrationAction = Extract<SetupAction, { kind: 'register-mcp' }>

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
}

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

async function writeRecipe(action: AddAction | SetAction): Promise<string | null> {
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
    await writeFile(path, action.recipeFile.content, { encoding: 'utf8', flag: 'wx' })
    return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`refusing to overwrite worktree recipe ${path}; re-run orch setup plan`)
    }
    throw error
  }
}

export function applyMcpRegistration(
  action: RegistrationAction,
  runner: SetupCommandRunner = runSetupCommand,
): 'applied' | 'unchanged' {
  if (!action.replace && guardRegistrationAdd(action, runner)) return 'unchanged'
  if (action.harness === 'claude' && action.replace) removeClaudeRegistration(action, runner)
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
    `${action.harness} ${action.server.name} changed before add (${detail}); run orch setup apply to review and replace it`,
  )
}

function removeClaudeRegistration(action: RegistrationAction, runner: SetupCommandRunner): void {
  const removeArgv = mcpRemoveArgv(action.harness, action.bin, action.server.name)
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
      const status = await applySetupAction(action, service, runner)
      results.push({ ...action, status, message: null })
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
  runner: SetupCommandRunner,
): Promise<'applied' | 'unchanged'> {
  if (
    action.kind === 'unchanged' ||
    action.kind === 'mcp-unchanged' ||
    action.kind === 'mcp-skipped'
  ) {
    return 'unchanged'
  }
  if (action.kind === 'register-mcp') return applyMcpRegistration(action, runner)
  if (action.kind === 'add') {
    await applyAddAction(action, service)
    return 'applied'
  }
  if (action.kind === 'set') {
    await applySetAction(action, service)
    return 'applied'
  }
  return 'unchanged'
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
    await compensateRecipe(error, createdRecipe)
  }
}

async function compensateRecipe(error: unknown, createdRecipe: string | null): Promise<never> {
  if (!createdRecipe) throw error
  try {
    await rm(createdRecipe)
  } catch (cleanupError) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; could not remove recipe created by this apply: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    )
  }
  throw error
}
