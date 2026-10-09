// concern: settings-machine-hooks
/** Pure declaration and merge of product-owned machine hooks. */

import { dirname, join } from 'node:path'
import {
  BOARD_ACK_STOP_BLOCKS,
  BOARD_PUSH_REFRESH_SECONDS,
  BOARD_PUSH_REMIND_SECONDS,
  BOARD_PUSH_RETRY_SECONDS,
  BOARD_PUSH_SLOW_TIMEOUT_SECONDS,
} from '../board/board-delivery.ts'
import { isPlainObject, type OwnedSettings } from './settings.ts'

const SCRIPT_FILES = [
  'block-agent.py',
  'no-attribution.py',
  'git-guard.py',
  'heartbeat-remind.py',
  'board-interrupt.py',
  'score-reminder.py',
  'heartbeat-guard.py',
  'workflow-cursor-reminder.py',
  'board-ack-guard.py',
  'session-brief.py',
  'test-substance-guard.py',
] as const

type ScriptFile = (typeof SCRIPT_FILES)[number]
type HookEvent = 'PreToolUse' | 'SubagentStart' | 'PostToolUse' | 'Stop' | 'SessionStart'
type HookCondition = string | { absoluteOrch: 'do' | 'land' }
type ProductHookDeclaration = {
  event: HookEvent
  matcher?: string
  if?: HookCondition
  script: ScriptFile
  timeout?: number
  boardEnvironment?: boolean
}

export type SupersededProfileHook = {
  event: string
  matcher?: string
  script: ScriptFile
}

export type MachineProductHooksResult = {
  settings: OwnedSettings
  superseded: SupersededProfileHook[]
}

const PRODUCT_HOOKS: readonly ProductHookDeclaration[] = [
  { event: 'PreToolUse', matcher: 'Agent|Task|Workflow', script: 'block-agent.py' },
  { event: 'PreToolUse', matcher: 'Bash', script: 'no-attribution.py' },
  { event: 'PreToolUse', matcher: 'Bash', script: 'git-guard.py' },
  {
    event: 'PreToolUse',
    matcher: 'Write|Edit|MultiEdit',
    script: 'test-substance-guard.py',
  },
  { event: 'SubagentStart', matcher: '*', script: 'block-agent.py' },
  { event: 'PostToolUse', matcher: 'Bash', if: 'Bash(orch do:*)', script: 'heartbeat-remind.py' },
  {
    event: 'PostToolUse',
    matcher: 'Bash',
    if: { absoluteOrch: 'do' },
    script: 'heartbeat-remind.py',
  },
  {
    event: 'PostToolUse',
    matcher: 'Bash',
    if: 'Bash(orch land:*)',
    script: 'heartbeat-remind.py',
  },
  {
    event: 'PostToolUse',
    matcher: 'Bash',
    if: { absoluteOrch: 'land' },
    script: 'heartbeat-remind.py',
  },
  {
    event: 'PostToolUse',
    matcher: '*',
    script: 'board-interrupt.py',
    timeout: Math.ceil(BOARD_PUSH_SLOW_TIMEOUT_SECONDS + 1),
    boardEnvironment: true,
  },
  { event: 'Stop', script: 'score-reminder.py' },
  { event: 'Stop', script: 'heartbeat-guard.py' },
  { event: 'Stop', script: 'workflow-cursor-reminder.py' },
  {
    event: 'Stop',
    matcher: '*',
    script: 'board-ack-guard.py',
    timeout: Math.ceil(BOARD_PUSH_SLOW_TIMEOUT_SECONDS + 1),
    boardEnvironment: true,
  },
  { event: 'SessionStart', script: 'session-brief.py' },
  { event: 'SessionStart', script: 'workflow-cursor-reminder.py' },
]

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

function scriptPath(assetRoot: string, file: ScriptFile): string {
  return join(assetRoot, 'orchestrator', 'hooks', file)
}

function resolvedCondition(value: HookCondition | undefined, assetRoot: string) {
  if (typeof value === 'string' || value === undefined) return value
  return `Bash(${join(assetRoot, 'bin', 'orch')} ${value.absoluteOrch}:*)`
}

function boardCommand(file: ScriptFile, assetRoot: string, databasePath: string): string {
  return [
    `BOARD_PUSH_REFRESH_SECONDS=${BOARD_PUSH_REFRESH_SECONDS}`,
    `BOARD_PUSH_REMIND_SECONDS=${BOARD_PUSH_REMIND_SECONDS}`,
    `BOARD_PUSH_RETRY_SECONDS=${BOARD_PUSH_RETRY_SECONDS}`,
    `BOARD_ACK_STOP_BLOCKS=${BOARD_ACK_STOP_BLOCKS}`,
    `BOARD_PUSH_SLOW_TIMEOUT_SECONDS=${BOARD_PUSH_SLOW_TIMEOUT_SECONDS}`,
    `ORCH_DB=${shellQuote(databasePath)}`,
    `ORCH_BOARD_HOOK_STATE=${shellQuote(join(dirname(databasePath), 'board-hook-state'))}`,
    'python3',
    shellQuote(scriptPath(assetRoot, file)),
  ].join(' ')
}

function declaredHandler(
  declaration: ProductHookDeclaration,
  assetRoot: string,
  databasePath: string,
) {
  const hookCondition = resolvedCondition(declaration.if, assetRoot)
  return {
    type: 'command',
    command: declaration.boardEnvironment
      ? boardCommand(declaration.script, assetRoot, databasePath)
      : `python3 ${scriptPath(assetRoot, declaration.script)}`,
    ...(hookCondition === undefined ? {} : { if: hookCondition }),
    ...(declaration.timeout === undefined ? {} : { timeout: declaration.timeout }),
  }
}

function declaredGroups(assetRoot: string, databasePath: string) {
  const groups = new Map<HookEvent, Array<Record<string, unknown>>>()
  for (const declaration of PRODUCT_HOOKS) {
    const eventGroups = groups.get(declaration.event) ?? []
    const previous = eventGroups.at(-1)
    const previousMatcher = isPlainObject(previous) ? previous.matcher : undefined
    if (previous && previousMatcher === declaration.matcher && Array.isArray(previous.hooks)) {
      previous.hooks.push(declaredHandler(declaration, assetRoot, databasePath))
    } else {
      eventGroups.push({
        ...(declaration.matcher === undefined ? {} : { matcher: declaration.matcher }),
        hooks: [declaredHandler(declaration, assetRoot, databasePath)],
      })
    }
    groups.set(declaration.event, eventGroups)
  }
  return groups
}

function declaredScript(command: unknown): ScriptFile | undefined {
  if (typeof command !== 'string') return undefined
  return SCRIPT_FILES.find((file) => {
    const needle = `orchestrator/hooks/${file}`
    const index = command.indexOf(needle)
    if (index < 0) return false
    const next = command[index + needle.length]
    return next === undefined || next === "'" || next === '"' || /\s/.test(next)
  })
}

/** Replace profile copies of product hooks and append the canonical product declaration. */
export function withMachineProductHooks(
  settings: OwnedSettings,
  assetRoot: string,
  databasePath: string,
): MachineProductHooksResult {
  const profileHooks = isPlainObject(settings.hooks) ? settings.hooks : {}
  const superseded: SupersededProfileHook[] = []
  const hooks = withoutSupersededProfileHooks(profileHooks, superseded)

  for (const [event, groups] of declaredGroups(assetRoot, databasePath)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : []
    hooks[event] = [...existing, ...groups]
  }
  return { settings: { ...settings, hooks }, superseded }
}

function withoutSupersededProfileHooks(
  profileHooks: Record<string, unknown>,
  superseded: SupersededProfileHook[],
): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}

  for (const [event, value] of Object.entries(profileHooks)) {
    if (!Array.isArray(value)) {
      hooks[event] = value
      continue
    }
    const groups: unknown[] = []
    for (const group of value) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        groups.push(group)
        continue
      }
      const handlers = group.hooks.filter((handler) => {
        const script = isPlainObject(handler) ? declaredScript(handler.command) : undefined
        if (!script) return true
        superseded.push({
          event,
          ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}),
          script,
        })
        return false
      })
      if (handlers.length > 0) groups.push({ ...group, hooks: handlers })
    }
    if (groups.length > 0) hooks[event] = groups
  }
  return hooks
}
