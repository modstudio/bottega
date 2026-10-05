import type { Command } from 'commander'
import { registerBoardClaimCommands } from './board-claim-commands.ts'
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
import { declineBoardSuggestion, postBoardSuggestion } from './board-suggestions.ts'
import {
  acceptAnswer,
  askQuestion,
  fileAnswerNote,
  readThread,
  replyToThread,
} from './board-thread-service.ts'

export function parseBoardDuration(value: string): number {
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
    .action((options) => {
      if (options.deadline && !options.ackRequired)
        throw new Error('--deadline requires --ack-required')
      const posted = postNotice({
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
    .action((options) => {
      console.log(
        JSON.stringify(
          askQuestion({
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
    .action((id, options) => console.log(JSON.stringify(replyToThread(Number(id), options.body))))
  board.command('thread <id>').action((id) => console.log(JSON.stringify(readThread(Number(id)))))
  board.command('accept <question-id> <reply-id>').action(async (questionId, replyId) => {
    const accepted = await acceptAnswer(Number(questionId), Number(replyId))
    console.log(JSON.stringify(accepted))
  })
  board.command('file-note <question-id>').action(async (questionId) => {
    console.log(JSON.stringify(await fileAnswerNote(Number(questionId))))
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
          postBoardSuggestion(Number(id), {
            audience: options.audience,
            title: options.title,
            body: options.body,
            task: options.task,
            paths: options.path,
            topics: options.topic,
          }),
        ),
      )
    })
  suggestion.command('decline <id>').action((id) => declineBoardSuggestion(Number(id)))
}
