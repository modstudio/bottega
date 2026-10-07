/** Live vendor event log: append-only JSONL plus last_event_at, and orch peek. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveRunsDirectory } from './database/database-location.ts'
import { db, nowIso, writableDb } from './database/db.ts'
import { targetGitEnvironment } from './git/git-environment.ts'

/** The live-stream subset the JSONL log records. Wider transport events are ignored. */
export type StreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'usage'; tokens: number; costUsd: number | null }
  | {
      kind: 'tool'
      title: string
      status?: string
      toolKind?: string
      server?: string
      target?: string
      result?: string
      error?: string
      locations?: Array<{ path: string }>
    }

const DEFAULT_IDLE_WARN_MS = 5 * 60_000
const DEFAULT_PEEK_EVENTS = 5
const PEEK_TEXT_CHARS = 120

export type RunLogEvent =
  | { ts: string; type: 'text'; text: string }
  | { ts: string; type: 'note'; noteId: number; candidateIds: number[] }
  | {
      ts: string
      type: 'tool_call'
      kind?: string
      title: string
      locations?: Array<{ path: string }>
    }
  | { ts: string; type: 'tool_result'; status?: string; bytes?: number }
  | { ts: string; type: 'usage'; tokens: number; costUsd?: number | null }
  | {
      ts: string
      type: 'ask_expected'
      transport: 'host' | 'srt'
      command: string[]
    }
  | { ts: string; type: 'ask_started'; tools: string[] }
  | { ts: string; type: 'ask_initialized' }
  | { ts: string; type: 'ask_listed'; tools: string[] }

type PeekEventSummary =
  | { type: 'text'; text: string }
  | { type: 'note'; noteId: number; candidateIds: number[] }
  | { type: 'tool_call'; title: string; target?: string }
  | { type: 'tool_result'; status?: string; bytes?: number }
  | { type: 'usage'; tokens: number }
  | { type: 'ask_expected'; transport: 'host' | 'srt'; command: string[] }
  | { type: 'ask_started'; tools: string[] }
  | { type: 'ask_initialized' }
  | { type: 'ask_listed'; tools: string[] }

export type PeekSummary = {
  id: number
  status: string
  agent: string
  job: string
  elapsed_ms: number
  seconds_since_last_event: number | null
  event_count: number
  events: PeekEventSummary[]
  files: string[]
  commits: string[]
  vendor_tokens: number | null
  last_event_at: string | null
  idle: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function runEventsPath(id: number, runsDir = resolveRunsDirectory(process.env)): string {
  return join(runsDir, String(id), 'events.jsonl')
}

export function idleWarnMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORCH_IDLE_WARN_MS
  if (raw === undefined || raw === '') return DEFAULT_IDLE_WARN_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_WARN_MS
}

export function idleLabel(
  lastEventAt: string | null | undefined,
  startedAt: string,
  now = Date.now(),
  thresholdMs = idleWarnMs(),
): string | null {
  const since = Date.parse(lastEventAt || startedAt)
  if (!Number.isFinite(since)) return null
  const idleMs = Math.max(0, now - since)
  if (idleMs < thresholdMs) return null
  return `idle ${Math.floor(idleMs / 60_000)}m`
}

export function idleMsSince(
  lastEventAt: string | null | undefined,
  startedAt: string,
  now = Date.now(),
): number | null {
  const since = Date.parse(lastEventAt || startedAt)
  if (!Number.isFinite(since)) return null
  return Math.max(0, now - since)
}

function touchLastEventAt(runId: number, ts: string): void {
  if (!runId) return
  try {
    writableDb().query('UPDATE run SET last_event_at=? WHERE id=?').run(ts, runId)
  } catch {
    /* best-effort: a live tee must not fail the vendor process */
  }
}

export function appendRunEvent(
  runId: number,
  event: RunLogEvent,
  path = runEventsPath(runId),
): void {
  // Best-effort, like touchLastEventAt: the live log observes the vendor
  // stream and must never fail the run or reach its outcome (review 349).
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(event)}\n`)
  } catch {
    /* a missing or unwritable run directory loses the log line, nothing else */
  }
  if (isWorkerActivity(event)) touchLastEventAt(runId, event.ts)
}

function isWorkerActivity(event: RunLogEvent): boolean {
  return !['ask_expected', 'ask_started', 'ask_initialized', 'ask_listed'].includes(event.type)
}

const RESULT_STATUSES = new Set(['completed', 'failed', 'ok', 'error', 'cancelled'])

export function createEventLog(
  runId: number,
  path = runEventsPath(runId),
): {
  observe(event: StreamEvent, ts?: string): void
  flush(ts?: string): void
} {
  let pending = ''
  const write = (event: RunLogEvent) => appendRunEvent(runId, event, path)
  const flush = (ts = nowIso()) => {
    if (!pending) return
    const text = pending
    pending = ''
    write({ ts, type: 'text', text })
  }
  return {
    observe(event, ts = nowIso()) {
      touchLastEventAt(runId, ts)
      if (event.kind === 'text') {
        pending += event.text
        return
      }
      flush(ts)
      if (event.kind === 'tool') {
        const locations =
          event.locations?.filter((item) => item.path) ??
          (event.target ? [{ path: event.target }] : undefined)
        const title = event.title
        const isResult = Boolean(event.result) || RESULT_STATUSES.has(event.status ?? '')
        if (title || event.toolKind || locations?.length) {
          write({
            ts,
            type: 'tool_call',
            kind: event.toolKind,
            title,
            ...(locations?.length ? { locations } : {}),
          })
        }
        if (isResult) {
          const bytes =
            event.result === undefined ? undefined : Buffer.byteLength(event.result, 'utf8')
          write({
            ts,
            type: 'tool_result',
            status: event.status,
            ...(bytes !== undefined ? { bytes } : {}),
          })
        }
        return
      }
      if (event.kind === 'usage') {
        write({ ts, type: 'usage', tokens: event.tokens, costUsd: event.costUsd })
      }
    },
    flush,
  }
}

export async function teeTransportEvents(
  events: AsyncIterable<{ kind: string }>,
  runId: number,
): Promise<void> {
  const log = createEventLog(runId)
  try {
    for await (const event of events) {
      try {
        log.observe(event as StreamEvent)
      } catch {
        /* observation never rejects the tee */
      }
    }
  } catch {
    /* an events source that throws ends the tee, not the run */
  } finally {
    try {
      log.flush()
    } catch {
      /* same */
    }
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function locationsFromUnknown(value: unknown): Array<{ path: string }> | undefined {
  if (Array.isArray(value)) {
    const locations = value.flatMap((item) => {
      if (typeof item === 'string' && item) return [{ path: item }]
      if (isRecord(item) && typeof item.path === 'string' && item.path) return [{ path: item.path }]
      return []
    })
    return locations.length ? locations : undefined
  }
  if (!isRecord(value)) return undefined
  const paths = [value.path, value.file_path, value.file, value.target, value.target_file].filter(
    (item): item is string => typeof item === 'string' && Boolean(item),
  )
  return paths.length ? paths.map((path) => ({ path })) : undefined
}

function toolEvent(opts: {
  title: string
  status?: string
  toolKind?: string
  server?: string
  target?: string
  result?: string
  error?: string
  locations?: Array<{ path: string }>
}): Extract<StreamEvent, { kind: 'tool' }> {
  return { kind: 'tool', ...opts }
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => {
      if (!isRecord(part)) return []
      if (part.type === 'text' && typeof part.text === 'string') return [part.text]
      return []
    })
    .join('')
}

function toolKindFromName(name: string): string {
  return name === 'read_file' ? 'read' : name
}

function toolUseEvents(content: unknown): StreamEvent[] {
  if (!Array.isArray(content)) return []
  const events: StreamEvent[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    if (part.type !== 'tool_use' && part.type !== 'tool_result') continue
    if (part.type === 'tool_use') {
      const title = stringField(part.name) ?? 'tool'
      const locations = locationsFromUnknown(part.input)
      events.push(
        toolEvent({
          title,
          toolKind: toolKindFromName(title),
          target: locations?.[0]?.path,
          locations,
        }),
      )
      continue
    }
    const result =
      typeof part.content === 'string'
        ? part.content
        : Array.isArray(part.content)
          ? assistantText(part.content)
          : JSON.stringify(part.content ?? '')
    events.push(
      toolEvent({
        title: stringField(part.tool_use_id) ?? 'tool',
        status: part.is_error ? 'failed' : 'completed',
        result: result || undefined,
      }),
    )
  }
  return events
}

function codexToolOutcome(
  item: Record<string, unknown>,
  phase: string,
): { status: string; error?: string } {
  const error =
    typeof item.error === 'string'
      ? item.error
      : isRecord(item.error)
        ? stringField(item.error.message)
        : undefined
  const reportedStatus = stringField(item.status)
  if (error || reportedStatus === 'failed' || reportedStatus === 'error') {
    return { status: 'failed', ...(error ? { error } : {}) }
  }
  return { status: phase === 'completed' ? 'completed' : 'in_progress' }
}

const CODEX_TOOL_ITEM_TYPES = new Set(['mcp_tool_call', 'web_search', 'file_change'])

function codexRichToolEvent(
  item: Record<string, unknown>,
  itemType: string,
  phase: string,
): StreamEvent {
  const title =
    stringField(item.tool) ?? stringField(item.query) ?? stringField(item.server) ?? itemType
  const locations = locationsFromUnknown(item.changes) ?? locationsFromUnknown(item)
  const result = typeof item.result === 'string' ? item.result : undefined
  const outcome = codexToolOutcome(item, phase)
  return toolEvent({
    title,
    toolKind: itemType === 'file_change' ? 'edit' : itemType === 'web_search' ? 'search' : 'mcp',
    status: outcome.status,
    result,
    ...(itemType === 'mcp_tool_call' ? { server: stringField(item.server) } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    locations,
    target: locations?.[0]?.path,
  })
}

function usageFrom(value: unknown): Extract<StreamEvent, { kind: 'usage' }> | null {
  if (!isRecord(value)) return null
  const input = typeof value.input_tokens === 'number' ? value.input_tokens : 0
  const output = typeof value.output_tokens === 'number' ? value.output_tokens : 0
  const cached =
    typeof value.cache_read_input_tokens === 'number' ? value.cache_read_input_tokens : 0
  const created =
    typeof value.cache_creation_input_tokens === 'number' ? value.cache_creation_input_tokens : 0
  const total =
    typeof value.total_tokens === 'number' ? value.total_tokens : input + output + cached + created
  if (!total && input === 0 && output === 0) return null
  const cost =
    typeof value.costUsd === 'number'
      ? value.costUsd
      : typeof value.total_cost_usd === 'number'
        ? value.total_cost_usd
        : null
  return { kind: 'usage', tokens: total, costUsd: cost }
}

function eventsFromCodexItem(item: Record<string, unknown>, phase: string): StreamEvent[] {
  const itemType = stringField(item.type) ?? ''
  if (itemType === 'agent_message') {
    const text = stringField(item.text) ?? ''
    return text ? [{ kind: 'text', text }] : []
  }
  if (itemType === 'command_execution') {
    const title = stringField(item.command) ?? 'command'
    const output = stringField(item.aggregated_output)
    const locations = locationsFromUnknown(item)
    if (phase === 'started' || phase === 'updated') {
      return [toolEvent({ title, toolKind: 'execute', status: 'in_progress', locations })]
    }
    return [
      toolEvent({
        title,
        toolKind: 'execute',
        status: item.exit_code === 0 || item.exit_code === undefined ? 'completed' : 'failed',
        result: output,
        locations,
      }),
    ]
  }
  if (CODEX_TOOL_ITEM_TYPES.has(itemType)) {
    return [codexRichToolEvent(item, itemType, phase)]
  }
  return []
}

/** Lift one vendor JSONL line into orch's live event stream. Unknown shapes are ignored. */
export function eventsFromVendorLine(line: string): StreamEvent[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return []
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!isRecord(raw) || typeof raw.type !== 'string') return []
  const type = raw.type
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    if (!isRecord(raw.item)) return []
    const phase = type.slice('item.'.length)
    return eventsFromCodexItem(raw.item, phase)
  }
  if (type === 'turn.completed') {
    const usage = usageFrom(raw.usage)
    return usage ? [usage] : []
  }
  if (type === 'assistant') {
    const message = isRecord(raw.message) ? raw.message : raw
    const content = message.content
    const text = assistantText(content)
    return [...(text ? [{ kind: 'text' as const, text }] : []), ...toolUseEvents(content)]
  }
  if (type === 'user') {
    const message = isRecord(raw.message) ? raw.message : raw
    return toolUseEvents(message.content)
  }
  if (type === 'result') {
    const usage = usageFrom(raw.usage)
    const cost =
      typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : (usage?.costUsd ?? null)
    if (!usage) return []
    return [{ kind: 'usage', tokens: usage.tokens, costUsd: cost }]
  }
  if (type === 'content_block_start' && isRecord(raw.content_block)) {
    return toolUseEvents([raw.content_block])
  }
  if (type === 'content_block_delta' && isRecord(raw.delta) && raw.delta.type === 'text_delta') {
    const text = stringField(raw.delta.text)
    return text ? [{ kind: 'text', text }] : []
  }
  if (type === 'stream_event' && isRecord(raw.event)) {
    return eventsFromVendorLine(JSON.stringify(raw.event))
  }
  return []
}

export function readEventLog(path: string): RunLogEvent[] {
  if (!existsSync(path)) return []
  const events: RunLogEvent[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as RunLogEvent
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.ts === 'string' &&
        typeof parsed.type === 'string'
      ) {
        events.push(parsed)
      }
    } catch {
      /* a half-written line is not an event */
    }
  }
  return events
}

function summarizeEvent(event: RunLogEvent): PeekEventSummary {
  if (event.type === 'text') return { type: 'text', text: event.text.slice(0, PEEK_TEXT_CHARS) }
  if (event.type === 'note') {
    return { type: 'note', noteId: event.noteId, candidateIds: event.candidateIds }
  }
  if (event.type === 'tool_call') {
    return { type: 'tool_call', title: event.title, target: event.locations?.[0]?.path }
  }
  if (event.type === 'tool_result')
    return { type: 'tool_result', status: event.status, bytes: event.bytes }
  if (event.type === 'usage') return { type: 'usage', tokens: event.tokens }
  if (event.type === 'ask_expected') {
    return {
      type: 'ask_expected',
      transport: event.transport,
      command: event.command,
    }
  }
  if (event.type === 'ask_started') return { type: 'ask_started', tools: event.tools }
  if (event.type === 'ask_listed') return { type: 'ask_listed', tools: event.tools }
  return { type: 'ask_initialized' }
}

function git(cwd: string, args: string[]): string | null {
  const p = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}

function worktreeFiles(worktree: string | null, locations: string[]): string[] {
  const files = new Set<string>(locations)
  if (worktree && existsSync(worktree)) {
    const short = git(worktree, ['status', '--short'])
    if (short) for (const line of short.split('\n')) if (line) files.add(line)
  }
  return [...files]
}

function worktreeCommits(worktree: string | null, base: string | null): string[] {
  if (!worktree || !existsSync(worktree) || !base) return []
  const log = git(worktree, ['log', '--oneline', '--no-decorate', `${base}..HEAD`])
  if (!log) return []
  return log.split('\n').filter(Boolean)
}

export function peekRun(
  id: number,
  opts: { events?: number; now?: number; runsDir?: string } = {},
): PeekSummary {
  const row = db()
    .query(
      `SELECT id, status, agent, job, started_at, last_event_at, worktree, base_commit, vendor_tokens
       FROM run WHERE id=?`,
    )
    .get(id) as {
    id: number
    status: string
    agent: string
    job: string
    started_at: string
    last_event_at: string | null
    worktree: string | null
    base_commit: string | null
    vendor_tokens: number | null
  } | null
  if (!row) throw new Error(`no run ${id}`)
  const now = opts.now ?? Date.now()
  const started = Date.parse(row.started_at)
  const events = readEventLog(runEventsPath(id, opts.runsDir))
  const lastWorkerTs = events.findLast(isWorkerActivity)?.ts ?? row.last_event_at
  const lastAt = lastWorkerTs
    ? Date.parse(lastWorkerTs)
    : Date.parse(row.last_event_at || row.started_at)
  const limit = opts.events ?? DEFAULT_PEEK_EVENTS
  const locations = events.flatMap((event) =>
    event.type === 'tool_call' ? (event.locations ?? []).map((item) => item.path) : [],
  )
  const usage = [...events].reverse().find((event) => event.type === 'usage')
  return {
    id: row.id,
    status: row.status,
    agent: row.agent,
    job: row.job,
    elapsed_ms: Number.isFinite(started) ? Math.max(0, now - started) : 0,
    seconds_since_last_event: Number.isFinite(lastAt)
      ? Math.max(0, Math.round((now - lastAt) / 1000))
      : null,
    event_count: events.length,
    events: events.slice(-limit).map(summarizeEvent),
    files: worktreeFiles(row.worktree, locations),
    commits: worktreeCommits(row.worktree, row.base_commit),
    vendor_tokens: usage?.type === 'usage' ? usage.tokens : row.vendor_tokens,
    last_event_at: row.last_event_at ?? lastWorkerTs ?? null,
    idle: idleLabel(row.last_event_at ?? lastWorkerTs, row.started_at, now),
  }
}

function formatPeekEvent(event: PeekEventSummary): string {
  if (event.type === 'text') return `  text ${event.text}`
  if (event.type === 'note') {
    return `  note ${event.noteId}${event.candidateIds.length ? ` near ${event.candidateIds.join(',')}` : ''}`
  }
  if (event.type === 'tool_call') {
    return `  tool ${event.title}${event.target ? ` ${event.target}` : ''}`
  }
  if (event.type === 'tool_result') {
    return `  result ${event.status ?? ''}${event.bytes != null ? ` ${event.bytes}b` : ''}`.trimEnd()
  }
  if (event.type === 'usage') return `  usage ${event.tokens}`
  if (event.type === 'ask_expected') {
    return `  ask expected ${event.transport} ${event.command.join(' ')}`
  }
  if (event.type === 'ask_started') return `  ask started ${event.tools.join(',')}`
  if (event.type === 'ask_listed') return `  ask listed ${event.tools.join(',')}`
  return '  ask initialized'
}

export function formatPeek(summary: PeekSummary): string {
  const elapsed =
    summary.elapsed_ms < 60_000
      ? `${Math.round(summary.elapsed_ms / 1000)}s`
      : `${Math.floor(summary.elapsed_ms / 60_000)}m`
  const last =
    summary.seconds_since_last_event == null
      ? 'no events'
      : summary.seconds_since_last_event < 60
        ? `${summary.seconds_since_last_event}s ago`
        : `${Math.floor(summary.seconds_since_last_event / 60)}m ago`
  const lines = [
    `run ${summary.id}  ${summary.agent}  ${summary.job}  ${summary.status}` +
      (summary.idle ? `  ${summary.idle}` : ''),
    `elapsed ${elapsed}  last event ${last}  ${summary.event_count} event${summary.event_count === 1 ? '' : 's'}` +
      (summary.vendor_tokens != null ? `  tokens ${summary.vendor_tokens}` : ''),
  ]
  if (summary.events.length) {
    lines.push('events:')
    for (const event of summary.events) lines.push(formatPeekEvent(event))
  }
  if (summary.files.length) {
    lines.push('files:')
    for (const file of summary.files) lines.push(`  ${file}`)
  }
  if (summary.commits.length) {
    lines.push('commits:')
    for (const commit of summary.commits) lines.push(`  ${commit}`)
  }
  return lines.join('\n')
}
