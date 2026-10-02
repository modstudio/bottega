// concern: setup-apply
/** Applies planned project actions in order through the project register service boundary. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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

async function writeRecipe(action: AddAction | SetAction): Promise<void> {
  if (!action.recipeFile) return
  const path = resolve(action.path, action.recipeFile.path)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, action.recipeFile.content, { encoding: 'utf8', flag: 'wx' })
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
    if (
      action.kind === 'unchanged' ||
      action.kind === 'mcp-unchanged' ||
      action.kind === 'mcp-skipped'
    ) {
      results.push({ ...action, status: 'unchanged', message: null })
      continue
    }
    try {
      if (action.kind === 'register-mcp') {
        const status = applyMcpRegistration(action, runner)
        results.push({ ...action, status, message: null })
        continue
      } else if (action.kind === 'add') {
        await writeRecipe(action)
        await service.add({
          path: action.path,
          name: action.name,
          stack: action.stack,
          canon: true,
          settings: action.settings,
          allowIncomplete: false,
        })
      } else if (action.kind === 'set') {
        await writeRecipe(action)
        await service.fillAbsent({ name: action.currentName, fill: action.fill })
      }
      results.push({ ...action, status: 'applied', message: null })
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
