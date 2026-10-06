import type { Command } from 'commander'
import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { adoptHostedBoard } from './board-adoption.ts'
import { registerBoardClaimCommands } from './board-claim-commands.ts'
import { claimBoardNotices, markBoardNoticesDelivered, readBoardNotices } from './board-delivery.ts'
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
import { listBoardOverview } from './board-overview.ts'
import { recordPresence } from './board-service.ts'
import { declineBoardSuggestion, postBoardSuggestion } from './board-suggestions.ts'

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
  board
    .command('adopt')
    .option('--confirm <total>', 'confirm the current candidate count', (value: string) => {
      const total = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(total))
        throw new Error('--confirm must be a non-negative integer')
      return total
    })
    .option('--json')
    .action(async (options) => {
      const result = await adoptHostedBoard({ confirm: options.confirm })
      if (options.json) return console.log(JSON.stringify(result))
      console.log(result.note)
      for (const kind of ['notice', 'question', 'reply', 'claim'] as const)
        console.log(`${kind}: ${result.counts[kind]} will be uploaded`)
      for (const row of result.stays)
        console.log(`${row.kind} ${row.id} stays local: ${row.reason}`)
      if (result.status === 'plan')
        console.log(`rerun with: orch board adopt --confirm ${result.total}`)
      else {
        console.log(
          `moved ${result.uploaded}; stayed ${result.refused}; remaining ${result.remaining}`,
        )
        if (result.message) console.log(result.message)
      }
    })
  board.command('presence').action(() => {
    recordPresence()
  })
  board
    .command('list')
    .option('--kind <kind>', 'limit to notice or question', (value: string) => {
      if (value !== 'notice' && value !== 'question')
        throw new Error('--kind must be notice or question')
      return value
    })
    .option('--open', 'list unanswered questions only')
    .option('--include-ended', 'include withdrawn and expired roots')
    .action(async (options) => {
      console.log(
        JSON.stringify(
          await listBoardOverview({
            kind: options.kind,
            open: Boolean(options.open),
            includeEnded: Boolean(options.includeEnded),
          }),
        ),
      )
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
    .action(async (options) => {
      const delivery = options.claim
        ? await claimBoardNotices(Boolean(options.all))
        : await readBoardNotices(Boolean(options.all))
      console.log(
        JSON.stringify({
          notices: delivery.notices.map((notice) => ({ ...notice, id: String(notice.id) })),
          warning: delivery.warning,
        }),
      )
    })
  board.command('delivered <ids>').action(async (ids) => {
    const parsed = String(ids).split(',')
    if (!parsed.length) throw new Error('board delivered ids are required')
    await markBoardNoticesDelivered(parsed)
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
