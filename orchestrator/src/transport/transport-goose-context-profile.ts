// concern: transport-goose-context-profile
/** Extracts the durable context summary from Goose's short-lived request and usage ledgers. */

import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { GooseContextProfile } from '../run/run-context-profile.ts'

export type GooseUsageRow = {
  isCompaction: unknown
  cacheReadTokens: unknown
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

/** Fold already-read Goose values without knowing files or SQLite. */
export function foldGooseContextProfile(
  requestLine: unknown | null,
  usageRows: GooseUsageRow[] | null,
): GooseContextProfile | null {
  const input =
    requestLine && typeof requestLine === 'object'
      ? (requestLine as { input?: { messages?: unknown; tools?: unknown } }).input
      : undefined
  const messages = Array.isArray(input?.messages) ? input.messages : null
  const first = messages?.[0] as { role?: unknown; content?: unknown } | undefined
  const systemChars =
    first?.role === 'system' && typeof first.content === 'string' ? first.content.length : null
  const tools = Array.isArray(input?.tools) ? input.tools : null
  const toolCount = tools?.length ?? null
  const toolSchemaChars = tools === null ? null : JSON.stringify(tools).length

  let compactions: number | null = null
  let cacheReadTokens: number | null = null
  if (usageRows !== null) {
    compactions = 0
    cacheReadTokens = 0
    for (const row of usageRows) {
      if (safeInteger(row.isCompaction) === 1) compactions++
      cacheReadTokens += safeInteger(row.cacheReadTokens) ?? 0
    }
  }

  const profile = { systemChars, toolCount, toolSchemaChars, compactions, cacheReadTokens }
  return Object.values(profile).every((value) => value === null) ? null : profile
}

/** Prefer the newest agent-loop request, which carries the tool list, over a tool-less helper call. */
export function chooseProfileRequest(newestFirst: unknown[]): unknown | null {
  const hasTools = (line: unknown) =>
    Array.isArray((line as { input?: { tools?: unknown } } | null)?.input?.tools)
  return newestFirst.find(hasTools) ?? newestFirst[0] ?? null
}

// Goose names request logs by index (0 newest) or by uuid, so recency is the file's mtime.
function requestLinesNewestFirst(gooseDir: string): unknown[] {
  const logs = join(gooseDir, 'logs')
  let entries: { path: string; mtimeMs: number }[]
  try {
    entries = readdirSync(logs)
      .filter((name) => /^llm_request\.[^/]+\.jsonl$/.test(name))
      .flatMap((name) => {
        try {
          const path = join(logs, name)
          return [{ path, mtimeMs: statSync(path).mtimeMs }]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
  return entries.flatMap(({ path }) => {
    try {
      const firstLine = readFileSync(path, 'utf8').split('\n', 1)[0]
      return firstLine ? [JSON.parse(firstLine) as unknown] : []
    } catch {
      // A partial file does not hide the next readable request.
      return []
    }
  })
}

function usageRows(gooseDir: string): GooseUsageRow[] | null {
  let database: Database | null = null
  try {
    database = new Database(join(gooseDir, 'sessions', 'sessions.db'), {
      readonly: true,
      strict: true,
    })
    return database
      .query<{ is_compaction: number | null; cache_read_tokens: number | null }, []>(
        'SELECT is_compaction, cache_read_tokens FROM usage_ledger',
      )
      .all()
      .map((row) => ({
        isCompaction: row.is_compaction,
        cacheReadTokens: row.cache_read_tokens,
      }))
  } catch {
    return null
  } finally {
    try {
      database?.close()
    } catch {
      // A locked or disappearing copied database leaves its fields null.
    }
  }
}

/** Best-effort adapter: a malformed, missing, or locked Goose ledger never escapes. */
export function gooseContextProfile(gooseDir: string): GooseContextProfile | null {
  try {
    return foldGooseContextProfile(
      chooseProfileRequest(requestLinesNewestFirst(gooseDir)),
      usageRows(gooseDir),
    )
  } catch {
    return null
  }
}
