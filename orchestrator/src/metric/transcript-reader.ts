// concern: metric
/** Owns the Claude transcript walk, per-line reader, row reader, and usage parser. */

import type { Dirent } from 'node:fs'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

export type TranscriptSource = { file: string; modifiedAt: Date; open(): Readable }
type TranscriptLineOptions = {
  signal?: AbortSignal
  beforeLine?: () => void
  afterLine?: () => void
}
export type ClaudeUsage = {
  input: number
  cacheRead: number
  cacheCreation: number
  output: number
}

export function claudeUsage(value: unknown): ClaudeUsage | null {
  if (!value || typeof value !== 'object') return null
  const usage = value as Record<string, unknown>
  const number = (key: string) => (typeof usage[key] === 'number' ? usage[key] : 0)
  return {
    input: number('input_tokens'),
    cacheRead: number('cache_read_input_tokens'),
    cacheCreation: number('cache_creation_input_tokens'),
    output: number('output_tokens'),
  }
}

function transcriptFiles(
  directory: string,
  unreadable: 'ignore' | 'throw' = 'ignore',
  out: string[] = [],
): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (unreadable === 'throw')
      throw new Error(
        `cannot read transcript directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      )
    return out
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) transcriptFiles(path, unreadable, out)
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

export function transcriptSources(
  root: string,
  unreadable: 'ignore' | 'throw' = 'ignore',
): TranscriptSource[] {
  if (root === '') return []
  return transcriptFiles(root, unreadable).flatMap((file) => {
    try {
      return [{ file, modifiedAt: statSync(file).mtime, open: () => createReadStream(file) }]
    } catch (error) {
      if (unreadable === 'throw')
        throw new Error(
          `cannot read transcript ${file}: ${error instanceof Error ? error.message : String(error)}`,
        )
      return []
    }
  })
}

async function releaseStream(stream: Readable): Promise<void> {
  if (stream.closed) return
  await new Promise<void>((resolve) => {
    stream.once('close', resolve)
    stream.destroy()
  })
}

export async function readTranscriptLines(
  source: TranscriptSource,
  consume: (line: string) => void,
  options: TranscriptLineOptions = {},
): Promise<void> {
  const stream = source.open()
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  const abort = () => {
    lines.close()
    stream.destroy()
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    for await (const line of lines) {
      options.beforeLine?.()
      consume(line)
      options.afterLine?.()
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    lines.close()
    await releaseStream(stream)
  }
}

export async function readTranscriptRows<T>(source: TranscriptSource): Promise<T[]> {
  const rows: T[] = []
  await readTranscriptLines(source, (line) => {
    try {
      rows.push(JSON.parse(line) as T)
    } catch {}
  })
  return rows
}

const sessionIdFound = Symbol('sessionIdFound')

/** Read only through the first row that identifies a transcript's owning session. */
export async function readTranscriptSessionId(source: TranscriptSource): Promise<string | null> {
  let sessionId: string | null = null
  try {
    await readTranscriptLines(source, (line) => {
      try {
        const row = JSON.parse(line) as { sessionId?: unknown }
        if (typeof row.sessionId !== 'string') return
        sessionId = row.sessionId
        throw sessionIdFound
      } catch (error) {
        if (error === sessionIdFound) throw error
      }
    })
  } catch (error) {
    if (error !== sessionIdFound) throw error
  }
  return sessionId
}
