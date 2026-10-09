import type { Database } from 'bun:sqlite'
import type { Dirent } from 'node:fs'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DEFAULT_IDLE_CAP_MS, spansFromTimestamps, union } from '../../../shared/interval.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { attribute, isInjected, projectOf, refreshKeyPrefixes } from '../attribute.ts'
import { nowIso, writeTransaction } from '../db.ts'
import { signedInRecordUserId } from '../sync.ts'
import { decideCollectorReplace, type ExistingIntervalRow } from './interval-replace.ts'

type TranscriptRoot = { source: 'read'; path: string } | { source: 'disabled' }

/** Decide which transcript root to use from facts gathered by the environment adapter. */
export function resolveTranscriptRoot(resolved: string): TranscriptRoot {
  return resolved === '' ? { source: 'disabled' } : { source: 'read', path: resolved }
}

/** Build the refusal for a resolved transcript root that cannot be read. */
export function unreadableTranscriptRootMessage(path: string): string {
  return `Cannot read hub.transcript_root ${path}; set HUB_TRANSCRIPT_ROOT to a readable path or set HUB_TRANSCRIPT_ROOT="" to disable transcript ingest`
}

/** Every .jsonl transcript under a root. */
function transcripts(dir: string, out: string[] = []): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) transcripts(p, out)
    else if (e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

/**
 * One contiguous stretch of work in one place.
 *
 * A single transcript is not one unit: a session can move between repos, and
 * one that ran for six hours across three tasks must not have all of it
 * charged to whichever task it mentioned first. So a transcript is cut wherever
 * the working directory changes, and each piece is attributed on its own.
 */
type Leg = {
  cwd: string
  ref: string
  stamps: number[]
  prompts: string[]
  /** Spend kept with the instant it happened, never as a leg-level total. */
  spend: { at: number; tokens: number }[]
  sessionId?: string | null
}

function usageSpend(u: Record<string, number | undefined>): number {
  return (
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.input_tokens ?? 0) +
    (u.output_tokens ?? 0)
  )
}

function userText(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null) return null
  const content = (msg as { content?: unknown }).content
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as { type?: string; text?: string }
    // A tool result is the transcript talking to itself, not the user.
    if (t.type === 'tool_result') return null
    if (t.type === 'text' && typeof t.text === 'string') parts.push(t.text)
  }
  return parts.join('\n').trim() || null
}

async function legsOf(file: string, ref: string, sinceMs: number): Promise<Leg[]> {
  const legs: Leg[] = []
  let cur: Leg | null = null
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })

  for await (const line of rl) {
    let d: {
      timestamp?: string
      cwd?: string
      sessionId?: string
      type?: string
      message?: unknown
    }
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const ts = d.timestamp ? new Date(d.timestamp).getTime() : NaN
    if (!Number.isFinite(ts) || ts < sinceMs) continue
    const cwd = d.cwd ?? ''
    if (!cwd) continue

    if (!cur || cur.cwd !== cwd) {
      if (cur && cur.stamps.length) legs.push(cur)
      cur = { cwd, ref, stamps: [], prompts: [], spend: [], sessionId: d.sessionId ?? null }
    }
    cur.stamps.push(ts)

    const usage = (d.message as { usage?: Record<string, number> } | undefined)?.usage
    if (usage) cur.spend.push({ at: ts, tokens: usageSpend(usage) })

    if (d.type === 'user') {
      const text = userText(d.message)
      if (text && !isInjected(text)) cur.prompts.push(text.slice(0, 4000))
    }
  }
  if (cur && cur.stamps.length) legs.push(cur)
  return legs
}

/**
 * A leg's spans, each carrying the spend that actually happened inside it.
 *
 * **Time and spend are two measurements that share a span, not one derived from
 * the other.** Apportioning a leg's tokens across its spans by duration — the
 * obvious first cut — is wrong twice: it dates spend by how long a gap was
 * rather than when the message landed, and it silently drops every token from a
 * leg too short to have a span at all. Measured against 2026-08-31 that lost
 * **1.35 billion tokens, 32% of the day**, while looking like it worked.
 *
 * So each message's spend is charged to the span containing its timestamp, and
 * a leg with only one message still emits a **zero-length span**: real spend,
 * no measurable duration. That is the honest reading of a single message, and
 * it keeps the token total conserved — which is the only property that makes
 * the reconciliation against the day grain meaningful.
 */
export function spendingSpans(leg: Leg, idleCapMs: number) {
  const spans = union(spansFromTimestamps(leg.stamps, idleCapMs)).map((s) => ({ ...s, tokens: 0 }))

  if (!spans.length) {
    if (!leg.spend.length) return []
    const at = Math.min(...leg.spend.map((s) => s.at))
    return [{ start: at, end: at, tokens: leg.spend.reduce((t, s) => t + s.tokens, 0) }]
  }

  for (const { at, tokens } of leg.spend) {
    // The last message sits exactly on the final span's end boundary, so a
    // strict `< end` test would drop it. Clamping to the nearest span keeps
    // every token, which is the point.
    let idx = spans.findIndex((s) => at >= s.start && at < s.end)
    if (idx < 0) {
      idx =
        at <= spans[0]!.start
          ? 0
          : spans.reduce((best, s, i) => (at >= s.start ? i : best), spans.length - 1)
    }
    spans[idx]!.tokens += tokens
  }
  return spans
}

type TranscriptIntervalRow = {
  source: 'claude'
  ref: string
  start_at: string
  end_at: string
  task_key: string | null
  project: string | null
  claude_tokens: number
  via: string | null
  session_id: string | null
  user_id: string | null
}

function replaceTranscriptWindow(
  conn: Database,
  fileRefs: readonly string[],
  since: string,
  recomputed: readonly TranscriptIntervalRow[],
) {
  const existing: ExistingIntervalRow[] = []
  const select = conn.query<ExistingIntervalRow, [string, string]>(
    `SELECT record_id, source, ref, start_at FROM interval
     WHERE source = 'claude' AND ref LIKE ? AND end_at >= ?`,
  )
  for (const ref of fileRefs) existing.push(...select.all(`claude:${ref}:%`, since))
  const decision = decideCollectorReplace(existing, recomputed)
  const update = conn.query(
    `UPDATE interval SET task_key=?, project=?, agent=NULL, end_at=?, claude_tokens=?,
       vendor_tokens=0, vendor_cost_usd=NULL, via=?, session_id=?, user_id=?
     WHERE record_id=?`,
  )
  const insert = conn.query(
    `INSERT INTO interval (record_id, task_key, project, source, agent, start_at, end_at,
                           claude_tokens, vendor_tokens, vendor_cost_usd, ref, via, session_id, user_id)
     VALUES (?, ?, ?, 'claude', NULL, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
  )
  const remove = conn.query(`DELETE FROM interval WHERE record_id=?`)
  for (const row of decision.updates)
    update.run(
      row.task_key,
      row.project,
      row.end_at,
      row.claude_tokens,
      row.via,
      row.session_id,
      row.user_id,
      row.record_id,
    )
  for (const row of decision.inserts)
    insert.run(
      newRecordId(),
      row.task_key,
      row.project,
      row.start_at,
      row.end_at,
      row.claude_tokens,
      row.ref,
      row.via,
      row.session_id,
      row.user_id,
    )
  for (const recordId of decision.deletes) remove.run(recordId)
}

/**
 * Claude Code transcripts, as spans of engaged time carrying their token spend.
 */
export async function ingestTranscripts(
  since: string,
  idleCapMs = DEFAULT_IDLE_CAP_MS,
  attributedUserId?: string | null,
): Promise<{ files: number; rows: number; source: 'read' | 'disabled' }> {
  refreshKeyPrefixes()
  const root = resolveTranscriptRoot(readMachineValue('hub.transcript_root'))
  if (root.source === 'disabled') return { files: 0, rows: 0, source: 'disabled' }

  try {
    readdirSync(root.path)
  } catch {
    throw new Error(unreadableTranscriptRootMessage(root.path))
  }

  const userId = attributedUserId === undefined ? await signedInRecordUserId() : attributedUserId
  const sinceMs = new Date(since).getTime()
  const sinceDay = since.slice(0, 10)
  // Replace this file's window by (source, ref, start_at): a surviving start
  // keeps its UUID, a new start inserts, and a start the file no longer
  // produces is deleted. Scope is the file prefix, not session id, because
  // several .jsonl files can carry the same sessionId.
  let files = 0
  let rows = 0

  for (const file of transcripts(root.path)) {
    // The cheap 90%: a file untouched since the window opened cannot contain a
    // message inside it.
    try {
      if (statSync(file).mtime.toISOString().slice(0, 10) < sinceDay) continue
    } catch {
      continue
    }
    files++

    const ref = file.startsWith(root.path + '/') ? file.slice(root.path.length + 1) : file
    const legs = (await legsOf(file, ref, sinceMs))
      // Work outside registered projects is left out rather than charged to a
      // project it never touched.
      .filter((l) => projectOf(l.cwd))
    if (!legs.length) continue

    writeTransaction((conn) => {
      // The leg ordinal is part of the ref. Without it two legs of one session
      // can collide on (source, ref, start_at): a zero-length span sits exactly
      // where the next leg begins, which is precisely when the working
      // directory changed between two adjacent messages — common, not exotic.
      const shaped = legs.map((leg, i) => ({
        leg,
        i,
        a: attribute({ cwd: leg.cwd, prompts: leg.prompts }),
        spans: spendingSpans(leg, idleCapMs),
      }))

      /**
       * A leg that named nothing borrows from the nearest leg of the SAME
       * session that did. Last resort, and a weak one: measured against legs
       * whose key is known it is right 39% of the time - so it is recorded as
       * `sibling-leg` and must not be read as fact.
       *
       * It replaced a commit window that scored 3% on that same holdout, which
       * is roughly what naming an open ticket at random would score. The window
       * asked "what was committed in this repo nearby" and answered with a task
       * key; in a repo carrying a dozen concurrent worktrees that is usually
       * somebody else's ticket. This at least asks about THIS session.
       *
       * Seeded only from DIRECT attributions, never from another borrowed key:
       * chaining would let one worktree leg color an entire day. Same project
       * only, because a session moves between repos and the nearest leg in time
       * may be in a different one.
       */
      const anchors = shaped.filter(
        (x) => x.a.key && (x.a.via === 'worktree' || x.a.via === 'prompt') && x.spans.length,
      )
      const startOf = (x: (typeof shaped)[number]) => Math.min(...x.spans.map((s) => s.start))
      for (const x of shaped) {
        if (x.a.key || !x.spans.length) continue
        const near = anchors
          .filter((an) => an.a.project === x.a.project)
          .sort((p, q) => Math.abs(startOf(p) - startOf(x)) - Math.abs(startOf(q) - startOf(x)))[0]
        if (near) {
          x.a.key = near.a.key
          x.a.via = 'sibling-leg'
        }
      }

      const recomputed: TranscriptIntervalRow[] = []
      shaped.forEach(({ leg, i, a, spans }) => {
        for (const s of spans) {
          recomputed.push({
            source: 'claude',
            ref: `claude:${leg.ref}:${i}`,
            start_at: new Date(s.start).toISOString(),
            end_at: new Date(s.end).toISOString(),
            task_key: a.key,
            project: a.project,
            claude_tokens: s.tokens,
            via: a.via,
            session_id: leg.sessionId ?? null,
            user_id: userId,
          })
        }
      })
      replaceTranscriptWindow(conn, [...new Set(legs.map((l) => l.ref))], since, recomputed)
      rows += recomputed.length
    })
  }

  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO setting (key, value) VALUES ('collect.transcripts.at', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(nowIso())),
  )
  return { files, rows, source: 'read' }
}
