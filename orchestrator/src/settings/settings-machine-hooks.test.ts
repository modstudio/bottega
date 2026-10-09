import { expect, test } from 'bun:test'
import {
  BOARD_ACK_STOP_BLOCKS,
  BOARD_PUSH_REFRESH_SECONDS,
  BOARD_PUSH_REMIND_SECONDS,
  BOARD_PUSH_RETRY_SECONDS,
  BOARD_PUSH_SLOW_TIMEOUT_SECONDS,
} from '../board/board-delivery.ts'
import { withMachineProductHooks } from './settings-machine-hooks.ts'

const ASSET_ROOT = '/installed/product'
const DATABASE = '/state/orchestrator/orch.db'
const OLD_ROOT = '/Users/operator/Projects/bottega'
const command = (file: string) => `python3 ${OLD_ROOT}/orchestrator/hooks/${file}`
const handler = (file: string, extra: Record<string, unknown> = {}) => ({
  type: 'command',
  command: command(file),
  ...extra,
})

const profileHooks = {
  PreToolUse: [
    { matcher: 'Agent|Task|Workflow', hooks: [handler('block-agent.py')] },
    {
      matcher: 'Bash',
      hooks: [handler('no-attribution.py'), handler('git-guard.py', { if: 'Bash(git:*)' })],
    },
  ],
  SubagentStart: [{ matcher: '*', hooks: [handler('block-agent.py')] }],
  PostToolUse: [
    {
      matcher: 'Bash',
      hooks: [
        handler('heartbeat-remind.py', { if: 'Bash(orch do:*)' }),
        handler('heartbeat-remind.py', { if: `Bash(${OLD_ROOT}/bin/orch do:*)` }),
        handler('heartbeat-remind.py', { if: 'Bash(orch land:*)' }),
        handler('heartbeat-remind.py', { if: `Bash(${OLD_ROOT}/bin/orch land:*)` }),
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        handler('score-reminder.py'),
        handler('heartbeat-guard.py'),
        handler('workflow-cursor-reminder.py'),
      ],
    },
  ],
  SessionStart: [{ hooks: [handler('session-brief.py'), handler('workflow-cursor-reminder.py')] }],
}

function render(hooks: unknown) {
  return withMachineProductHooks({ permissions: {}, hooks }, ASSET_ROOT, DATABASE)
}

test('typed profile hooks and an empty profile render the same canonical product hooks', () => {
  const fromProfile = render(profileHooks)
  const fromEmpty = render({})
  expect(fromProfile.settings.hooks).toEqual(fromEmpty.settings.hooks)

  const commands = JSON.stringify(fromProfile.settings.hooks)
  const groups = Object.values(
    fromProfile.settings.hooks as Record<string, Array<{ hooks: unknown[] }>>,
  ).flat()
  expect(groups.flatMap((group) => group.hooks)).toHaveLength(16)
  expect(commands).not.toContain(OLD_ROOT)
  expect(commands.match(/git-guard\.py/g)).toHaveLength(1)
  expect(commands.match(/heartbeat-remind\.py/g)).toHaveLength(4)
})

test('unrelated profile handlers survive unchanged and in place', () => {
  const before = { type: 'command', command: 'notify-before' }
  const after = { type: 'command', command: 'notify-after' }
  const result = render({
    PreToolUse: [{ matcher: 'Bash', hooks: [before, handler('git-guard.py'), after] }],
  })
  const firstGroup = (result.settings.hooks as Record<string, Array<Record<string, unknown>>>)
    .PreToolUse?.[0]
  expect(firstGroup).toEqual({ matcher: 'Bash', hooks: [before, after] })
})

test('git guard covers every Bash command and has no condition', () => {
  const hooks = render({}).settings.hooks as Record<
    string,
    Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
  >
  const preToolUse = hooks.PreToolUse ?? []
  const guard = preToolUse
    .flatMap((group) => group.hooks)
    .find((item) => String(item.command).endsWith('/git-guard.py'))
  expect(preToolUse.find((group) => group.hooks.includes(guard!))?.matcher).toBe('Bash')
  expect(guard).not.toHaveProperty('if')
})

test('test substance guard covers every editor tool from the rendered install', () => {
  const hooks = render({}).settings.hooks as Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ command: string; type: string }> }>
  >
  const group = hooks.PreToolUse?.find((item) => item.matcher === 'Write|Edit|MultiEdit')
  expect(group?.hooks).toEqual([
    {
      type: 'command',
      command: `python3 ${ASSET_ROOT}/orchestrator/hooks/test-substance-guard.py`,
    },
  ])
})

test('product hook rendering is a fixed point', () => {
  const first = render({})
  const second = withMachineProductHooks(first.settings, ASSET_ROOT, DATABASE)
  expect(second.settings.hooks).toEqual(first.settings.hooks)
})

test('superseded handlers name exactly the removed profile entries', () => {
  expect(render(profileHooks).superseded).toEqual([
    { event: 'PreToolUse', matcher: 'Agent|Task|Workflow', script: 'block-agent.py' },
    { event: 'PreToolUse', matcher: 'Bash', script: 'no-attribution.py' },
    { event: 'PreToolUse', matcher: 'Bash', script: 'git-guard.py' },
    { event: 'SubagentStart', matcher: '*', script: 'block-agent.py' },
    ...Array.from({ length: 4 }, () => ({
      event: 'PostToolUse',
      matcher: 'Bash',
      script: 'heartbeat-remind.py' as const,
    })),
    { event: 'Stop', script: 'score-reminder.py' },
    { event: 'Stop', script: 'heartbeat-guard.py' },
    { event: 'Stop', script: 'workflow-cursor-reminder.py' },
    { event: 'SessionStart', script: 'session-brief.py' },
    { event: 'SessionStart', script: 'workflow-cursor-reminder.py' },
  ])
})

test('board hook commands preserve their environment and timeout', () => {
  const hooks = render({}).settings.hooks as Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>
  >
  const boardHooks = Object.values(hooks)
    .flat()
    .flatMap((group) => group.hooks)
    .filter((hook) => hook.command.includes('BOARD_PUSH_REFRESH_SECONDS='))
  expect(boardHooks).toHaveLength(2)
  for (const hook of boardHooks) {
    expect(hook.command).toContain(`BOARD_PUSH_REFRESH_SECONDS=${BOARD_PUSH_REFRESH_SECONDS}`)
    expect(hook.command).toContain(`BOARD_PUSH_REMIND_SECONDS=${BOARD_PUSH_REMIND_SECONDS}`)
    expect(hook.command).toContain(`BOARD_PUSH_RETRY_SECONDS=${BOARD_PUSH_RETRY_SECONDS}`)
    expect(hook.command).toContain(`BOARD_ACK_STOP_BLOCKS=${BOARD_ACK_STOP_BLOCKS}`)
    expect(hook.command).toContain(
      `BOARD_PUSH_SLOW_TIMEOUT_SECONDS=${BOARD_PUSH_SLOW_TIMEOUT_SECONDS}`,
    )
    expect(hook.timeout).toBe(Math.ceil(BOARD_PUSH_SLOW_TIMEOUT_SECONDS + 1))
  }
})
