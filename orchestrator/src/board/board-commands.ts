import type { Command } from 'commander'
import { registerBoardClaimCommands } from './board-claim-commands.ts'
import {
  boardAccept,
  boardAcknowledge,
  boardAsk,
  boardFileNote,
  boardPost,
  boardReply,
  boardStatus,
  boardThread,
  boardWithdraw,
} from './board-operations.ts'
import { claimNotices, markNoticesDelivered, readNotices, recordPresence } from './board-service.ts'
import { declineBoardSuggestion, postBoardSuggestion } from './board-suggestions.ts'

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

const collect = (value: string, values: string[] = []) => [...values, value]
const localBoardId = (value: string): number => {
  const id = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id))
    throw new Error(
      'board id must be a positive integer string because this operation is machine-local',
    )
  return id
}

export function registerBoardCommands(program: Command): void {
  const board = program.command('board')
  registerBoardClaimCommands(board, parseBoardDuration)
  board.command('presence').action(() => {
    recordPresence()
  })
  board
    .command('post')
    .requiredOption('--audience <expr>')
    .requiredOption('--title <text>')
    .requiredOption('--body <text>')
    .option('--task <key>')
    .option('--path <glob>', 'add a repository-relative path glob', collect, [])
    .option('--topic <name>', 'add a controlled board topic', collect, [])
    .option('--ack-required')
    .option('--deadline <duration>')
    .option('--expires <duration>')
    .action(async (options) => {
      if (options.deadline && !options.ackRequired)
        throw new Error('--deadline requires --ack-required')
      const posted = await boardPost({
        audience: options.audience,
        title: options.title,
        body: options.body,
        task: options.task,
        paths: options.path,
        topics: options.topic,
        ackRequired: Boolean(options.ackRequired),
        deadlineMs: options.deadline ? parseBoardDuration(options.deadline) : undefined,
        expiresMs: options.expires ? parseBoardDuration(options.expires) : undefined,
      })
      console.log(JSON.stringify(posted))
    })
  board
    .command('ask')
    .requiredOption('--audience <expr>')
    .requiredOption('--title <text>')
    .requiredOption('--body <text>')
    .option('--task <key>')
    .option('--path <glob>', 'add a repository-relative path glob', collect, [])
    .option('--topic <name>', 'add a controlled board topic', collect, [])
    .option('--expires <duration>')
    .action(async (options) => {
      console.log(
        JSON.stringify(
          await boardAsk({
            audience: options.audience,
            title: options.title,
            body: options.body,
            task: options.task,
            paths: options.path,
            topics: options.topic,
            expiresMs: options.expires ? parseBoardDuration(options.expires) : undefined,
          }),
        ),
      )
    })
  board
    .command('reply <root-id>')
    .requiredOption('--body <text>')
    .action(async (id, options) =>
      console.log(JSON.stringify(await boardReply(String(id), options.body))),
    )
  board
    .command('thread <id>')
    .action(async (id) => console.log(JSON.stringify(await boardThread(String(id)))))
  board.command('accept <question-id> <reply-id>').action(async (questionId, replyId) => {
    const accepted = await boardAccept(String(questionId), String(replyId))
    console.log(JSON.stringify(accepted))
  })
  board.command('file-note <question-id>').action(async (questionId) => {
    console.log(JSON.stringify(await boardFileNote(String(questionId))))
  })
  board
    .command('read')
    .option('--all')
    .option('--claim', 'read without stamping delivery (for the session-start hook)')
    .action((options) => {
      const notices = options.claim
        ? claimNotices(Boolean(options.all))
        : readNotices(Boolean(options.all))
      if (options.claim)
        console.log(JSON.stringify(notices.map((notice) => ({ ...notice, id: String(notice.id) }))))
      else for (const notice of notices) console.log(notice.text)
    })
  board.command('delivered <ids>').action((ids) => {
    const parsed = String(ids).split(',').map(localBoardId)
    if (!parsed.length || parsed.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw new Error('board delivered ids must be comma-separated positive integers')
    markNoticesDelivered(parsed)
  })
  board
    .command('ack <id>')
    .action(async (id) => console.log(JSON.stringify(await boardAcknowledge(String(id)))))
  board
    .command('status <id>')
    .action(async (id) => console.log(JSON.stringify(await boardStatus(String(id)))))
  board
    .command('withdraw <id>')
    .action(async (id) => console.log(JSON.stringify(await boardWithdraw(String(id)))))
  const suggestion = board.command('suggestion')
  suggestion
    .command('post <id>')
    .requiredOption('--audience <expr>')
    .option('--title <text>')
    .option('--body <text>')
    .option('--task <key>')
    .option('--path <glob>', 'replace repository-relative path globs', collect)
    .option('--topic <name>', 'replace controlled board topics', collect)
    .action((id, options) => {
      console.log(
        JSON.stringify(
          (() => {
            const posted = postBoardSuggestion(localBoardId(String(id)), {
              audience: options.audience,
              title: options.title,
              body: options.body,
              task: options.task,
              paths: options.path,
              topics: options.topic,
            })
            return { ...posted, id: String(posted.id) }
          })(),
        ),
      )
    })
  suggestion
    .command('decline <id>')
    .action((id) => declineBoardSuggestion(localBoardId(String(id))))
}
