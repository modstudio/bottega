import type { Command } from 'commander'
import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { adoptHostedBoard } from './board-adoption.ts'
import { registerBoardClaimCommands } from './board-claim-commands.ts'
import {
  BOARD_READ_REFRESH_BUDGET_MS,
  claimBoardNotices,
  markBoardNoticesDelivered,
  readBoardNotices,
} from './board-delivery.ts'
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
import { markBoardDeliveryDelivered, pendingBoardDelivery } from './board-push-service.ts'
import type { BoardDeliveryPoint } from './board-reach.ts'
import { registerBoardReachCommand } from './board-reach-command.ts'
import { recordPresence } from './board-service.ts'
import { declineBoardSuggestion, postBoardSuggestion } from './board-suggestions.ts'
import { watchHostedBoard } from './board-watch.ts'

const ARCHITECTS_AUDIENCE_HELP =
  'recipient; architects means this project, architects:all means every project, architects:<project> names one project'

function registerBoardWatchCommand(board: Command): void {
  board
    .command('presence')
    .option('--started-at <instant>', 'session-start instant', (value: string) => {
      const parsed = new Date(value)
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
        throw new Error('--started-at must be an ISO 8601 UTC instant with milliseconds')
      return value
    })
    .action((options) => {
      recordPresence(process.cwd(), process.env, options.startedAt)
    })
  board
    .command('watch')
    .description('hold the hosted board stream and refresh the local cache')
    .action(async () => {
      const code = await watchHostedBoard()
      if (code !== 0) process.exitCode = code
    })
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
const deliveryPoint = (value: string): BoardDeliveryPoint => {
  if (!['session-start', 'after-tool-call', 'stop', 'heartbeat-monitor'].includes(value))
    throw new Error('--point must be session-start, after-tool-call, stop, or heartbeat-monitor')
  return value as BoardDeliveryPoint
}

function registerBoardDeliveredCommand(board: Command): void {
  board
    .command('delivered <ids>')
    .option('--session <id>', 'session whose hook emitted the messages')
    .option('--point <point>', 'hook delivery point', deliveryPoint)
    .option('--emission <id>', 'identity of this hook emission')
    .option('--blocked-stop', 'the emitted delivery blocked Stop')
    .action(async (ids, options) => {
      const parsed = String(ids).split(',')
      if (!parsed.length) throw new Error('board delivered ids are required')
      if (options.point && !options.session) throw new Error('--point requires --session')
      if (options.point && !options.emission) throw new Error('--point requires --emission')
      if (options.blockedStop && options.point !== 'stop')
        throw new Error('--blocked-stop requires --point stop')
      if (options.session)
        await markBoardDeliveryDelivered({
          session: options.session,
          ids: parsed,
          emissionId: options.emission,
          deliveryPoint: options.point,
          blockedStop: Boolean(options.blockedStop),
        })
      else await markBoardNoticesDelivered(parsed)
    })
}

function registerBoardPendingCommand(board: Command): void {
  board
    .command('pending')
    .requiredOption('--session <id>')
    .option('--recently-injected <ids>', 'comma-separated message ids not yet due for reminder')
    .option('--exclude-acknowledgement-required')
    .option('--json')
    .action(async (options) => {
      const delivery = await pendingBoardDelivery({
        session: options.session,
        budgetMs: BOARD_READ_REFRESH_BUDGET_MS,
        includeAcknowledgementReminders: true,
        excludeAcknowledgementRequired: Boolean(options.excludeAcknowledgementRequired),
        recentlyInjectedIds: options.recentlyInjected
          ? String(options.recentlyInjected).split(',').filter(Boolean)
          : [],
      })
      console.log(
        JSON.stringify({
          delivery: delivery.delivery.map((notice) => ({
            id: notice.id,
            text: notice.text,
            requiresAcknowledgement: notice.requiresAcknowledgement,
          })),
          overflow: delivery.overflow,
          warning: delivery.warning,
          pendingAcknowledgements: delivery.pendingAcknowledgements.map((notice) => ({
            id: notice.id,
            text: notice.text,
            requiresAcknowledgement: true,
          })),
        }),
      )
    })
}

function registerBoardPostCommand(board: Command): void {
  board
    .command('post')
    .requiredOption('--audience <expr>', ARCHITECTS_AUDIENCE_HELP)
    .requiredOption('--title <text>')
    .requiredOption('--body <text>')
    .option(
      '--purpose <purpose>',
      'information sends one line, request sends the full body and lives four hours by default (set --expires for longer), standing also reaches later sessions',
    )
    .option('--task <key>')
    .option('--path <glob>', 'add a repository-relative path glob', collect, [])
    .option('--topic <name>', 'add a controlled board topic', collect, [])
    .option('--ack-required')
    .option('--deadline <duration>')
    .option('--expires <duration>')
    .action(async (options) => {
      if (options.deadline && !options.ackRequired)
        throw new Error('--deadline requires --ack-required')
      console.log(
        JSON.stringify(
          await boardPost({
            audience: options.audience,
            title: options.title,
            body: options.body,
            purpose: options.purpose,
            task: options.task,
            paths: options.path,
            topics: options.topic,
            ackRequired: Boolean(options.ackRequired),
            deadlineMs: options.deadline ? parseBoardDuration(options.deadline) : undefined,
            expiresMs: options.expires ? parseBoardDuration(options.expires) : undefined,
          }),
        ),
      )
    })
}

export function registerBoardCommands(program: Command): void {
  const board = program.command('board')
  registerBoardClaimCommands(board, parseBoardDuration)
  registerBoardReachCommand(board)
  registerBoardDeliveredCommand(board)
  registerBoardPendingCommand(board)
  registerBoardPostCommand(board)
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
      console.log(`receipt: ${result.receipts} will be uploaded`)
      for (const row of result.stays)
        console.log(`${row.kind} ${row.id} stays local: ${row.reason}`)
      if (result.status === 'plan')
        console.log(`rerun with: ${PLATFORM_SLUG} board adopt --confirm ${result.total}`)
      else {
        console.log(
          `moved ${result.uploaded}; stayed ${result.refused}; remaining ${result.remaining}`,
        )
        if (result.message) console.log(result.message)
      }
    })
  registerBoardWatchCommand(board)
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
    .command('ask')
    .requiredOption('--audience <expr>', ARCHITECTS_AUDIENCE_HELP)
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
          ...delivery,
          notices: delivery.notices.map((notice) => ({ ...notice, id: String(notice.id) })),
        }),
      )
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
    .requiredOption('--audience <expr>', ARCHITECTS_AUDIENCE_HELP)
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
