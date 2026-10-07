// concern: settings-machine-hooks
/** Declares product-owned machine hooks added after hosted user settings are read. */

import { assetPath } from '../../../shared/install-root.ts'
import { resolveOrchestratorDatabase } from '../../../shared/state-directory.ts'
import {
  BOARD_ACK_STOP_BLOCKS,
  BOARD_PUSH_REFRESH_SECONDS,
  BOARD_PUSH_REMIND_SECONDS,
  BOARD_PUSH_SLOW_TIMEOUT_SECONDS,
} from '../board/board-delivery.ts'
import { isPlainObject, type OwnedSettings } from './settings.ts'

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

function command(file: string): string {
  return [
    `BOARD_PUSH_REFRESH_SECONDS=${BOARD_PUSH_REFRESH_SECONDS}`,
    `BOARD_PUSH_REMIND_SECONDS=${BOARD_PUSH_REMIND_SECONDS}`,
    `BOARD_ACK_STOP_BLOCKS=${BOARD_ACK_STOP_BLOCKS}`,
    `BOARD_PUSH_SLOW_TIMEOUT_SECONDS=${BOARD_PUSH_SLOW_TIMEOUT_SECONDS}`,
    `ORCH_DB=${shellQuote(resolveOrchestratorDatabase(process.env))}`,
    shellQuote(assetPath('orchestrator', 'hooks', file)),
  ].join(' ')
}

const hook = (file: string) => ({ type: 'command', command: command(file), timeout: 3 })

export function withMachineBoardHooks(settings: OwnedSettings): OwnedSettings {
  const hooks = isPlainObject(settings.hooks) ? { ...settings.hooks } : {}
  const append = (event: 'PostToolUse' | 'Stop', matcher: string, file: string) => {
    const existing = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    existing.push({ matcher, hooks: [hook(file)] })
    hooks[event] = existing
  }
  append('PostToolUse', '*', 'board-interrupt.py')
  append('Stop', '*', 'board-ack-guard.py')
  return { ...settings, hooks }
}
