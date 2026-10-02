import type { Command } from 'commander'
import {
  acknowledgeNotice,
  claimNotices,
  markNoticesDelivered,
  noticeStatus,
  postNotice,
  readNotices,
  recordPresence,
  withdrawNotice,
} from './board-service.ts'

function parseBoardDuration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim())
  if (!match) throw new Error(`invalid duration ${value}; use a positive value such as 30m or 1d`)
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`invalid duration ${value}`)
  const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 'ms' | 's' | 'm' | 'h' | 'd'
  ]
  return amount * factor
}

export function registerBoardCommands(program: Command): void {
  const board = program.command('board')
  board.command('presence').action(() => {
    recordPresence()
  })
  board
    .command('post')
    .requiredOption('--audience <expr>')
    .requiredOption('--title <text>')
    .requiredOption('--body <text>')
    .option('--ack-required')
    .option('--deadline <duration>')
    .option('--expires <duration>')
    .action((options) => {
      if (options.deadline && !options.ackRequired)
        throw new Error('--deadline requires --ack-required')
      console.log(
        JSON.stringify(
          postNotice({
            audience: options.audience,
            title: options.title,
            body: options.body,
            ackRequired: Boolean(options.ackRequired),
            deadlineMs: options.deadline ? parseBoardDuration(options.deadline) : undefined,
            expiresMs: options.expires ? parseBoardDuration(options.expires) : undefined,
          }),
        ),
      )
    })
  board
    .command('read')
    .option('--all')
    .option('--claim', 'read without stamping delivery (for the session-start hook)')
    .action((options) => {
      const notices = options.claim
        ? claimNotices(Boolean(options.all))
        : readNotices(Boolean(options.all))
      if (options.claim) console.log(JSON.stringify(notices))
      else for (const notice of notices) console.log(notice.text)
    })
  board.command('delivered <ids>').action((ids) => {
    const parsed = String(ids).split(',').map(Number)
    if (!parsed.length || parsed.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw new Error('board delivered ids must be comma-separated positive integers')
    markNoticesDelivered(parsed)
  })
  board.command('ack <id>').action((id) => acknowledgeNotice(Number(id)))
  board.command('status <id>').action((id) => console.log(JSON.stringify(noticeStatus(Number(id)))))
  board.command('withdraw <id>').action((id) => withdrawNotice(Number(id)))
}
