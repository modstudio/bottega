// concern: session-losses
/** Pure compaction-loss policy over transcript rows and lifecycle facts. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PLATFORM_COMMAND_WORDS } from '../../../shared/command-spellings.ts'
import { BOARD_CLAIM_TOOL_NAMES } from '../mcp/mcp-board-claim-tools.ts'
import { type ClaudeUsage, claudeUsage } from '../metric/transcript-reader.ts'

const LOSS_JUDGE_WINDOW_TURNS = 8

type ObjectRow = Record<string, unknown>
export type TranscriptRow = ObjectRow & {
  type?: string
  subtype?: string
  timestamp?: string
  sessionId?: string
  requestId?: string
  isCompactSummary?: boolean
  compactMetadata?: { preTokens?: number; postTokens?: number; trigger?: string }
  message?: { id?: string; usage?: unknown; content?: unknown }
}
export type RunLifecycle = {
  id: string
  number: number
  startedAt: string
  terminalAt: string | null
}
export type CursorLifecycle = {
  id: string
  number: number
  createdAt: string
  terminalAt: string | null
  advancesAt: string[]
}
export type ClaimLifecycle = {
  id: string
  subject: string
  takenAt: string
  closedAt: string | null
}
export type LifecycleFacts = {
  runs: RunLifecycle[]
  cursors: CursorLifecycle[]
  claims: ClaimLifecycle[]
  unjudgedOwnerWindowMs: number
}
type TokenSplit = ClaudeUsage & { total: number }
type WindowStats = { turns: number; mean: number | null; p90: number | null }
type LossCandidate = {
  id: string
  kind: 'ask-user-question' | 'send-message-question' | 'workflow-await-question'
  at: string
  question: unknown
}
type CandidateFile = {
  sessionId: string
  boundaryAt: string
  earlierTurns: Array<{ role: 'user' | 'assistant'; at: string; text: string }>
  candidates: LossCandidate[]
}
type BoundaryLoss = {
  at: string
  preTokens: number | null
  postTokens: number | null
  trigger: string
  before: WindowStats
  after: WindowStats
  lost: {
    runs: { count: number; ids: string[] }
    cursors: { count: number; ids: string[] }
    claims: { count: number; ids: string[] }
  }
  candidates: CandidateFile
}
export type SessionLossReport = {
  sessionId: string
  firstRowAt: string
  lastRowAt: string
  wallHours: number
  tokens: TokenSplit
  tokensPerSessionHour: TokenSplit
  costPerSessionHour: 'subscription, unpriced'
  boundaries: BoundaryLoss[]
}

export const transcriptRowTime = (row: TranscriptRow) => Date.parse(row.timestamp ?? '')
export const hasTranscriptRowTime = (
  row: TranscriptRow,
): row is TranscriptRow & { timestamp: string } => Number.isFinite(transcriptRowTime(row))

function declaredCommandPattern(commands: string[]): RegExp {
  const declared = commands.map((command) => {
    if (!(PLATFORM_COMMAND_WORDS as readonly string[]).includes(command))
      throw new Error(`session-loss command spelling is not declared: ${command}`)
    return command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', String.raw`\s+`)
  })
  return new RegExp(String.raw`(?:${PLATFORM_SLUG}\s+)?(?:${declared.join('|')})\b`)
}

const runCollectionCommand = declaredCommandPattern([
  'run result',
  'run wait',
  'run continue',
  'score',
])
const claimCommand = declaredCommandPattern([
  'board claim renew',
  'board claim release',
  'board claim take',
])
const workflowAwaitCommand = declaredCommandPattern(['workflow await'])
const claimMutationTools = new Set<string>(BOARD_CLAIM_TOOL_NAMES.slice(0, 3))

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && typeof (part as ObjectRow).text === 'string'
        ? [(part as ObjectRow).text as string]
        : [],
    )
    .join('\n')
}

function toolsOf(row: TranscriptRow): Array<{ name: string; input: unknown }> {
  if (!Array.isArray(row.message?.content)) return []
  return row.message.content.flatMap((part) => {
    if (!part || typeof part !== 'object') return []
    const block = part as ObjectRow
    return block.type === 'tool_use' && typeof block.name === 'string'
      ? [{ name: block.name, input: block.input }]
      : []
  })
}

function assistantTurns(rows: TranscriptRow[]): TranscriptRow[] {
  const lastById = new Map<string, number>()
  rows.forEach((row, index) => {
    if (row.type !== 'assistant' || !claudeUsage(row.message?.usage)) return
    const id = row.message?.id ?? row.requestId
    if (id) lastById.set(id, index)
  })
  return rows.filter((row, index) => {
    if (row.type !== 'assistant' || !claudeUsage(row.message?.usage)) return false
    const id = row.message?.id ?? row.requestId
    return !id || lastById.get(id) === index
  })
}

function tokenSplit(rows: TranscriptRow[]): TokenSplit {
  const split = assistantTurns(rows).reduce<ClaudeUsage>(
    (sum, row) => {
      const usage = claudeUsage(row.message?.usage)!
      return {
        input: sum.input + usage.input,
        cacheRead: sum.cacheRead + usage.cacheRead,
        cacheCreation: sum.cacheCreation + usage.cacheCreation,
        output: sum.output + usage.output,
      }
    },
    { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 },
  )
  return { ...split, total: split.input + split.cacheRead + split.cacheCreation + split.output }
}

function windowStats(rows: TranscriptRow[]): WindowStats {
  const values = assistantTurns(rows)
    .map((row) => tokenSplit([row]).total)
    .sort((left, right) => left - right)
  if (!values.length) return { turns: 0, mean: null, p90: null }
  return {
    turns: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    p90: values[Math.max(0, Math.ceil(values.length * 0.9) - 1)]!,
  }
}

function toolText(row: TranscriptRow): string {
  return toolsOf(row)
    .map((tool) => `${tool.name} ${JSON.stringify(tool.input)}`)
    .join(' ')
}

function namesRun(row: TranscriptRow, run: RunLifecycle): boolean {
  const text = toolText(row)
  return (
    runCollectionCommand.test(text) &&
    (text.includes(run.id) || new RegExp(`(?:^|\\D)${run.number}(?:\\D|$)`).test(text))
  )
}

/**
 * Claim liveness is pointer liveness, not lease liveness: a claim is held from
 * taken_at until closed_at, ignoring lapses_at. Handling is evidenced by a
 * matching board claim tool input or by closed_at inside the boundary window;
 * mutable renewed_at is never historical evidence.
 */
function handlesClaim(row: TranscriptRow, claim: ClaimLifecycle): boolean {
  return toolsOf(row).some((tool) => {
    const text = `${tool.name} ${JSON.stringify(tool.input)}`
    const action = claimCommand.test(text) || claimMutationTools.has(tool.name)
    return action && (text.includes(claim.subject) || text.includes(claim.id))
  })
}

const within = (value: string, start: number, end: number) => {
  const time = Date.parse(value)
  return time > start && time <= end
}

function lostItems(
  boundary: number,
  windowEnd: number,
  rows: TranscriptRow[],
  facts: LifecycleFacts,
): BoundaryLoss['lost'] {
  const windowRows = rows.filter(
    (row) => transcriptRowTime(row) > boundary && transcriptRowTime(row) <= windowEnd,
  )
  const runs = facts.runs.filter((run) => {
    const terminal = run.terminalAt ? Date.parse(run.terminalAt) : null
    if (Date.parse(run.startedAt) > boundary || (terminal !== null && terminal <= boundary))
      return false
    const end = Math.min(
      windowEnd,
      terminal === null ? Number.POSITIVE_INFINITY : terminal + facts.unjudgedOwnerWindowMs,
    )
    return !windowRows.some((row) => transcriptRowTime(row) <= end && namesRun(row, run))
  })
  const cursors = facts.cursors.filter((cursor) => {
    const terminal = cursor.terminalAt ? Date.parse(cursor.terminalAt) : null
    if (Date.parse(cursor.createdAt) > boundary || (terminal !== null && terminal <= boundary))
      return false
    return !cursor.advancesAt.some((advanced) => within(advanced, boundary, windowEnd))
  })
  const claims = facts.claims.filter((claim) => {
    const closed = claim.closedAt ? Date.parse(claim.closedAt) : null
    if (Date.parse(claim.takenAt) > boundary || (closed !== null && closed <= boundary))
      return false
    return !(
      (claim.closedAt !== null && within(claim.closedAt, boundary, windowEnd)) ||
      windowRows.some((row) => handlesClaim(row, claim))
    )
  })
  return {
    runs: { count: runs.length, ids: runs.map((run) => run.id) },
    cursors: { count: cursors.length, ids: cursors.map((cursor) => cursor.id) },
    claims: { count: claims.length, ids: claims.map((claim) => claim.id) },
  }
}

function awaitQuestion(input: unknown): string | null {
  const text = typeof input === 'string' ? input : JSON.stringify(input)
  if (!workflowAwaitCommand.test(text)) return null
  return text.match(/--question(?:=|\s+)["']([^"']+)["']/)?.[1] ?? text
}

function candidateFromTool(
  row: TranscriptRow,
  tool: { name: string; input: unknown },
  index: number,
): LossCandidate[] {
  const base = {
    id: `${row.message?.id ?? row.requestId ?? row.timestamp}-${index}`,
    at: row.timestamp!,
  }
  if (tool.name === 'AskUserQuestion')
    return [{ ...base, kind: 'ask-user-question', question: tool.input }]
  const message =
    tool.input && typeof tool.input === 'object' ? (tool.input as ObjectRow).message : null
  if (tool.name === 'SendMessage' && typeof message === 'string' && message.trimEnd().endsWith('?'))
    return [{ ...base, kind: 'send-message-question', question: message }]
  const question = awaitQuestion(tool.input)
  return question ? [{ ...base, kind: 'workflow-await-question', question }] : []
}

function candidateFile(
  sessionId: string,
  boundaryAt: string,
  beforeRows: TranscriptRow[],
  afterRows: TranscriptRow[],
): CandidateFile {
  const found: LossCandidate[] = []
  for (const row of assistantTurns(afterRows).slice(0, LOSS_JUDGE_WINDOW_TURNS)) {
    for (const [index, tool] of toolsOf(row).entries())
      found.push(...candidateFromTool(row, tool, index))
  }
  const dedupedAssistant = new Set(assistantTurns(beforeRows))
  return {
    sessionId,
    boundaryAt,
    earlierTurns: beforeRows.flatMap((row) => {
      if (row.isCompactSummary || (row.type !== 'user' && row.type !== 'assistant')) return []
      if (row.type === 'assistant' && !dedupedAssistant.has(row)) return []
      const text = textOf(row.message?.content)
      return text ? [{ role: row.type, at: row.timestamp!, text }] : []
    }),
    candidates: found,
  }
}

export function measureSessionLosses(
  sessionId: string,
  inputRows: TranscriptRow[],
  facts: LifecycleFacts,
): SessionLossReport | null {
  const rows = inputRows
    .filter(hasTranscriptRowTime)
    .sort((left, right) => transcriptRowTime(left) - transcriptRowTime(right))
  if (!rows.length) return null
  const indexes = rows.flatMap((row, index) =>
    row.type === 'system' && row.subtype === 'compact_boundary' ? [index] : [],
  )
  const first = transcriptRowTime(rows[0]!)
  const last = transcriptRowTime(rows.at(-1)!)
  const wallHours = Math.max((last - first) / 3_600_000, 0)
  const tokens = tokenSplit(rows)
  const perHour = (value: number) => (wallHours === 0 ? 0 : value / wallHours)
  const boundaries = indexes.map((index, boundaryNumber): BoundaryLoss => {
    const boundary = rows[index]!
    const previous = boundaryNumber === 0 ? -1 : indexes[boundaryNumber - 1]!
    const next = indexes[boundaryNumber + 1] ?? rows.length
    const beforeRows = rows.slice(previous + 1, index).filter((row) => !row.isCompactSummary)
    const afterRows = rows.slice(index + 1, next).filter((row) => !row.isCompactSummary)
    const metadata = boundary.compactMetadata ?? {}
    return {
      at: boundary.timestamp!,
      preTokens: metadata.preTokens ?? null,
      postTokens: metadata.postTokens ?? null,
      trigger: metadata.trigger ?? 'unknown',
      before: windowStats(beforeRows),
      after: windowStats(afterRows),
      lost: lostItems(
        transcriptRowTime(boundary),
        next < rows.length ? transcriptRowTime(rows[next]!) : last,
        rows,
        facts,
      ),
      candidates: candidateFile(sessionId, boundary.timestamp!, beforeRows, afterRows),
    }
  })
  return {
    sessionId,
    firstRowAt: rows[0]!.timestamp!,
    lastRowAt: rows.at(-1)!.timestamp!,
    wallHours,
    tokens,
    tokensPerSessionHour: {
      input: perHour(tokens.input),
      cacheRead: perHour(tokens.cacheRead),
      cacheCreation: perHour(tokens.cacheCreation),
      output: perHour(tokens.output),
      total: perHour(tokens.total),
    },
    costPerSessionHour: 'subscription, unpriced',
    boundaries,
  }
}
