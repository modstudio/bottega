// concern: board-reach-command
/** Validates the board reach CLI edge and delegates to its measurement service. */

import type { Command } from 'commander'
import {
  BOARD_REACH_DEFAULT_HOURS,
  BOARD_REACH_MAX_HOURS,
  boardReachReport,
  renderBoardReach,
} from './board-reach.ts'

const positiveHours = (value: string): number => {
  const hours = Number(value)
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be a positive number')
  if (hours > BOARD_REACH_MAX_HOURS)
    throw new Error(
      `--hours cannot exceed ${BOARD_REACH_MAX_HOURS}; export reports regularly for longer history`,
    )
  return hours
}

export function registerBoardReachCommand(board: Command): void {
  board
    .command('reach')
    .option(
      '--hours <hours>',
      'measurement window in hours',
      positiveHours,
      BOARD_REACH_DEFAULT_HOURS,
    )
    .description('measure board-message reach and acknowledgement')
    .option('--json', 'write the reach report as JSON')
    .action((options) => {
      const report = boardReachReport(options.hours)
      console.log(options.json ? JSON.stringify(report) : renderBoardReach(report))
    })
}
