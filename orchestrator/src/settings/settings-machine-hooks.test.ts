import { expect, test } from 'bun:test'
import {
  BOARD_ACK_STOP_BLOCKS,
  BOARD_PUSH_REFRESH_SECONDS,
  BOARD_PUSH_REMIND_SECONDS,
  BOARD_PUSH_SLOW_TIMEOUT_SECONDS,
} from '../board/board-delivery.ts'
import { withMachineBoardHooks } from './settings-machine-hooks.ts'

test('machine board hooks cover every tool and Stop with the shared budgets', () => {
  const settings = withMachineBoardHooks({ permissions: {}, hooks: {} })
  const hooks = settings.hooks as Record<
    string,
    Array<{ matcher: string; hooks: Array<{ command: string }> }>
  >
  expect(hooks.PostToolUse?.[0]?.matcher).toBe('*')
  expect(hooks.Stop?.[0]?.matcher).toBe('*')
  const commands = [hooks.PostToolUse?.[0]?.hooks[0]?.command, hooks.Stop?.[0]?.hooks[0]?.command]
  for (const command of commands) {
    expect(command).toContain(`BOARD_PUSH_REFRESH_SECONDS=${BOARD_PUSH_REFRESH_SECONDS}`)
    expect(command).toContain(`BOARD_PUSH_REMIND_SECONDS=${BOARD_PUSH_REMIND_SECONDS}`)
    expect(command).toContain(`BOARD_ACK_STOP_BLOCKS=${BOARD_ACK_STOP_BLOCKS}`)
    expect(command).toContain(`BOARD_PUSH_SLOW_TIMEOUT_SECONDS=${BOARD_PUSH_SLOW_TIMEOUT_SECONDS}`)
  }
  expect(commands[0]).toContain('board-interrupt.py')
  expect(commands[1]).toContain('board-ack-guard.py')
})
