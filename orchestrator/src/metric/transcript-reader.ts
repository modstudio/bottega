// concern: metric
/** Owns the one Claude transcript walk, row reader, and usage parser used by metrics. */

import type { Dirent } from 'node:fs'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'

export type TranscriptSource = { file: string; modifiedAt: Date; open(): Readable }
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

export async function readTranscriptRows<T>(source: TranscriptSource): Promise<T[]> {
  const rows: T[] = []
  const stream = source.open()
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      try {
        rows.push(JSON.parse(line) as T)
      } catch {}
    }
  } finally {
    lines.close()
    if (!stream.closed) stream.destroy()
  }
  return rows
}
