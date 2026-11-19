// concern: bounded-jsonl-archive
/** Writes owner-only JSONL archives and bounds each archive directory by age. */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BOUNDED_JSONL_ARCHIVE_KEEP = 5

function archiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-')
}

export function writeBoundedJsonlArchive(
  rows: readonly unknown[],
  input: { directory: string; keep: number; now?: Date },
): string {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 })
  const path = join(input.directory, `${archiveTimestamp(input.now ?? new Date())}.jsonl`)
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 })
  const archives = readdirSync(input.directory)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
  for (const name of archives.slice(0, -input.keep)) rmSync(join(input.directory, name))
  return path
}
