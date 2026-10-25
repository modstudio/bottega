import type { Command } from 'commander'
import { parseBoardDuration } from '../../../shared/board-duration.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { adoptHostedBoard } from './board-adoption.ts'
import { registerBoardClaimCommands } from './board-claim-commands.ts'
import { claimBoardNotices, markBoardNoticesDelivered, readBoardNotices } from './board-delivery.ts'
import { BOARD_READ_REFRESH_BUDGET_MS } from './board-hosted-cache.ts'
import { resolveLocalBoardMessageIdentifier } from './board-message-identifier.ts'
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

function parseIsoInstant(flag: string) {
  return (value: string) => {
    const parsed = new Date(value)
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
      throw new Error(`${flag} must be an ISO 8601 UTC instant with milliseconds`)
    return value
  }
}

const BOARD_DESCRIPTIONS = {
  board: 'exchange messages and claims among architects',
  adopt: 'move eligible machine-local board records to the hosted board',
  list: 'list board notices and questions',
  ask: 'ask a question on the architects board',
  reply: 'reply to a board notice or question',
  thread: 'show a board thread and its replies',
  accept: 'accept a reply as the answer to a question',
  fileNote: 'file the accepted answer as a note',
  read: 'read board notices addressed to this session',
  acknowledge: 'acknowledge a board notice',
  status: 'show a board message and its delivery status',
  withdraw: 'withdraw a live board notice or question',
  suggestionPost: 'post a worker suggestion to the board',
  suggestionDecline: 'decline and withdraw a worker suggestion',
} as const

function registerBoardWatchCommand(board: Command): void {
  board
    .command('presence')
    .description('record this architect session as present')
    .option('--started-at <instant>', 'session-start instant', parseIsoInstant('--started-at'))
    .option(
      '--began-at <instant>',
      'session start recorded on insert only',
      parseIsoInstant('--began-at'),
    )
    .action((options) => {
      recordPresence(process.cwd(), process.env, options.startedAt, options.beganAt)
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
const deliveryPoint = (value: string): BoardDeliveryPoint => {
  if (!['session-start', 'after-tool-call', 'stop', 'heartbeat-monitor'].includes(value))
    throw new Error('--point must be session-start, after-tool-call, stop, or heartbeat-monitor')
  return value as BoardDeliveryPoint
}

function registerBoardDeliveredCommand(board: Command): void {
  board
    .command('delivered <ids>')
    .description('record board messages emitted by a delivery hook')
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
    .description('list messages due for delivery to a session')
    .requiredOption('--session <id>', 'select the recipient session')
    .option('--recently-injected <ids>', 'comma-separated message ids not yet due for reminder')
    .option('--exclude-acknowledgement-required', 'omit messages requiring acknowledgement')
    .option('--json', 'write the pending delivery as JSON')
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
    .description('post a notice to the architects board')
    .requiredOption('--audience <expr>', ARCHITECTS_AUDIENCE_HELP)
    .requiredOption('--title <text>', 'set the notice title')
    .requiredOption('--body <text>', 'set the notice body')
    .option(
      '--purpose <purpose>',
      'information sends one line, request sends the full body and lives four hours by default (set --expires for longer), standing also reaches later sessions',
    )
    .option('--task <key>', 'tag the notice with this task')
    .option('--path <glob>', 'add a repository-relative path glob', collect, [])
    .option(
      '--topic <name>',
      'add a controlled board topic; platform is for notices about changes to the platform every project depends on',
      collect,
      [],
    )
    .option(
      '--ack-required',
      'require acknowledgement for an operator post, an architect post to its own project, or a platform-topic request or standing post from the platform project to architects:all',
    )
    .option('--deadline <duration>', 'set the acknowledgement deadline')
    .option('--expires <duration>', 'set how long the notice remains live')
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

function registerBoardSuggestionCommands(board: Command): void {
  const suggestion = board.command('suggestion').description('dispose of worker board suggestions')
  suggestion
    .command('post <id>')
    .description(BOARD_DESCRIPTIONS.suggestionPost)
    .requiredOption('--audience <expr>', ARCHITECTS_AUDIENCE_HELP)
    .option('--title <text>', 'replace the suggested title')
    .option('--body <text>', 'replace the suggested body')
    .option('--task <key>', 'replace the suggested task tag')
    .option('--path <glob>', 'replace repository-relative path globs', collect)
    .option('--topic <name>', 'replace controlled board topics', collect)
    .action((id, options) => {
      console.log(
        JSON.stringify(
          (() => {
            const posted = postBoardSuggestion(
              resolveLocalBoardMessageIdentifier(db(), String(id)),
              {
                audience: options.audience,
                title: options.title,
                body: options.body,
                task: options.task,
                paths: options.path,
                topics: options.topic,
              },
            )
            return posted
          })(),
        ),
      )
    })
  suggestion
    .command('decline <id>')
    .description(BOARD_DESCRIPTIONS.suggestionDecline)
    .action((id) => declineBoardSuggestion(resolveLocalBoardMessageIdentifier(db(), String(id))))
}

export function registerBoardCommands(program: Command): void {
  const board = program.command('board').description(BOARD_DESCRIPTIONS.board)
  registerBoardClaimCommands(board, parseBoardDuration)
  registerBoardReachCommand(board)
  registerBoardDeliveredCommand(board)
  registerBoardPendingCommand(board)
  registerBoardPostCommand(board)
  board
    .command('adopt')
    .description(BOARD_DESCRIPTIONS.adopt)
    .option('--confirm <total>', 'confirm the current candidate count', (value: string) => {
      const total = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(total))
        throw new Error('--confirm must be a non-negative integer')
      return total
    })
    .option('--json', 'write the adoption result as JSON')
    .action(async (options) => {
      const result = await adoptHostedBoard({ confirm: options.confirm })
      if (options.json) return console.log(JSON.stringify(result))
      console.log(result.note)
      for (const kind of ['notice', 'question', 'reply', 'claim'] as const)
        console.log(`${kind}: ${result.counts[kind]} will be uploaded`)
      console.log(`receipt: ${result.receipts} will be uploaded`)
      for (const row of result.stays)
        console.log(`${row.kind} ${row.recordId} stays local: ${row.reason}`)
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
    .description(BOARD_DESCRIPTIONS.list)
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
    .description(BOARD_DESCRIPTIONS.ask)
    .requiredOption('--audience <expr>', ARCHITECTS_AUDIENCE_HELP)
    .requiredOption('--title <text>', 'set the question title')
    .requiredOption('--body <text>', 'set the question body')
    .option('--task <key>', 'tag the question with this task')
    .option('--path <glob>', 'add a repository-relative path glob', collect, [])
    .option('--topic <name>', 'add a controlled board topic', collect, [])
    .option('--expires <duration>', 'set how long the question remains live')
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
    .description(BOARD_DESCRIPTIONS.reply)
    .requiredOption('--body <text>', 'set the reply body')
    .option(
      '--audience <choice>',
      'participants, acknowledged, audience, operator, session:<id>, or run:<id>',
    )
    .action(async (id, options) =>
      console.log(
        JSON.stringify(await boardReply(String(id), options.body, undefined, options.audience)),
      ),
    )
  board
    .command('thread <id>')
    .description(BOARD_DESCRIPTIONS.thread)
    .action(async (id) => console.log(JSON.stringify(await boardThread(String(id)))))
  board
    .command('accept <question-id> <reply-id>')
    .description(BOARD_DESCRIPTIONS.accept)
    .action(async (questionId, replyId) => {
      const accepted = await boardAccept(String(questionId), String(replyId))
      console.log(JSON.stringify(accepted))
    })
  board
    .command('file-note <question-id>')
    .description(BOARD_DESCRIPTIONS.fileNote)
    .action(async (questionId) => {
      console.log(JSON.stringify(await boardFileNote(String(questionId))))
    })
  board
    .command('read')
    .description(BOARD_DESCRIPTIONS.read)
    .option('--all', 'include notices already delivered to this session')
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
    .description(BOARD_DESCRIPTIONS.acknowledge)
    .action(async (id) => console.log(JSON.stringify(await boardAcknowledge(String(id)))))
  board
    .command('status <id>')
    .description(BOARD_DESCRIPTIONS.status)
    .action(async (id) => console.log(JSON.stringify(await boardStatus(String(id)))))
  board
    .command('withdraw <id>')
    .description(BOARD_DESCRIPTIONS.withdraw)
    .action(async (id) => console.log(JSON.stringify(await boardWithdraw(String(id)))))
  registerBoardSuggestionCommands(board)
}
