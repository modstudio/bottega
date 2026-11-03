// concern: confined Codex rollout files
/**
 * Locates rollout files below one Codex home and reads a turn-local slice.
 * Reads only the bytes each file appended since its recorded offset, under a
 * declared byte cap, because one Codex home is shared by every run of a chain
 * and the operator home holds the whole machine's history.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { join, sep } from 'node:path'

/** Most bytes one turn's slice may materialise across every rollout file. */
export const CODEX_ROLLOUT_READ_CAP_BYTES = 64 * 1024 * 1024
/** Most bytes read from the head of one rollout file to recover its CLI version. */
export const CODEX_ROLLOUT_HEAD_BYTES = 64 * 1024

/** Why a turn's slice was dropped, reported to the caller as a value. */
export type CodexRolloutOverflow = {
  capBytes: number
  attemptedBytes: number
  message: string
}

export type CodexRolloutTexts = {
  /** Bytes appended since each file's offset; empty when the turn overflowed. */
  slice: string
  overflow: CodexRolloutOverflow | null
}

export function confinedCodexRollouts(home: string | undefined): string[] {
  if (!home) return []
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) return []
  try {
    const root = realpathSync(home)
    return [...new Bun.Glob('**/rollout-*.jsonl').scanSync({ cwd: sessions })]
      .sort()
      .flatMap((relative) => {
        const path = join(sessions, relative)
        const entry = lstatSync(path, { throwIfNoEntry: false })
        if (!entry?.isFile() || entry.isSymbolicLink()) return []
        const resolved = realpathSync(path)
        return resolved.startsWith(root + sep) ? [resolved] : []
      })
  } catch {
    return []
  }
}

/** Read a byte range so no string offset is ever mistaken for a byte offset. */
function readByteRange(path: string, from: number, length: number): string | null {
  try {
    const descriptor = openSync(path, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      const read = readSync(descriptor, buffer, 0, length, from)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(descriptor)
    }
  } catch {
    // Rollout observation is best-effort and never changes the run outcome.
    return null
  }
}

function rolloutOverflow(attemptedBytes: number, capBytes: number): CodexRolloutOverflow {
  return {
    capBytes,
    attemptedBytes,
    message:
      `codex rollout slice for this turn needs ${attemptedBytes} bytes of new rollout text, ` +
      `over CODEX_ROLLOUT_READ_CAP_BYTES (orchestrator/src/transport/codex-rollout-files.ts); ` +
      'no quota reading and no ask-exposure reading were taken for this turn; ' +
      'raise that constant if a turn legitimately appends more',
  }
}

function grew(path: string, from: number): number {
  try {
    return statSync(path).size - from
  } catch {
    return 0
  }
}

/**
 * Read only what the turn appended. A file absent from `offsets` is new to the
 * turn and is read from its start. Exceeding `capBytes` drops the slice and
 * reports the overflow instead of growing the process.
 */
export function codexRolloutTextsSince(
  home: string | undefined,
  offsets: Map<string, number>,
  capBytes: number = CODEX_ROLLOUT_READ_CAP_BYTES,
): CodexRolloutTexts {
  const slices: string[] = []
  let read = 0
  for (const path of confinedCodexRollouts(home)) {
    const from = Math.max(0, offsets.get(path) ?? 0)
    const length = grew(path, from)
    if (length <= 0) continue
    if (read + length > capBytes) return { slice: '', overflow: rolloutOverflow(read + length, capBytes) }
    const text = readByteRange(path, from, length)
    if (text === null) continue
    read += length
    slices.push(text)
  }
  return { slice: slices.join('\n'), overflow: null }
}

/**
 * The bounded version source: the head of each confined rollout file, which is
 * where `session_meta` carries `cli_version`. Consulted only when this turn's
 * slice did not yield one.
 */
export function codexRolloutVersionHeads(home: string | undefined): string {
  const heads: string[] = []
  for (const path of confinedCodexRollouts(home)) {
    const head = readByteRange(path, 0, CODEX_ROLLOUT_HEAD_BYTES)
    if (head) heads.push(head)
  }
  return heads.join('\n')
}
