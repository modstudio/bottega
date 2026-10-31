/** Bounded state-root JSON-lines file mechanics shared by best-effort measurements. */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveStateRoot, type StateEnvironment } from './state-directory.ts'

type BoundedLogOptions = {
  env?: StateEnvironment
  maxBytes: number
  name: string
}

export function boundedJsonLinePath(name: string, env: StateEnvironment = process.env): string {
  return join(resolveStateRoot(env), `${name}.jsonl`)
}

function logPaths(name: string, env: StateEnvironment): { current: string; previous: string } {
  const current = boundedJsonLinePath(name, env)
  return {
    current,
    previous: join(dirname(current), `${name.split('/').at(-1)}.previous.jsonl`),
  }
}

/** Append one JSON value, rotating when the byte bound is crossed. */
export function writeBoundedJsonLine(value: unknown, options: BoundedLogOptions): void {
  const paths = logPaths(options.name, options.env ?? process.env)
  const line = `${JSON.stringify(value)}\n`
  mkdirSync(dirname(paths.current), { recursive: true })
  let currentBytes = 0
  try {
    currentBytes = statSync(paths.current).size
  } catch {
    // An absent current file starts at zero; append below reports every other failure.
  }
  if (currentBytes > 0 && currentBytes + Buffer.byteLength(line) > options.maxBytes) {
    renameSync(paths.current, paths.previous)
  }
  appendFileSync(paths.current, line, 'utf8')
}

/** Append one JSON value best-effort, rotating when the byte bound is crossed. */
export function appendBoundedJsonLine(value: unknown, options: BoundedLogOptions): void {
  try {
    writeBoundedJsonLine(value, options)
  } catch {
    // Measurement must never replace the operation it observes.
  }
}

function readLog<T>(path: string, label: string, parse: (value: unknown) => T | null): T[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = parse(JSON.parse(line))
          return entry ? [entry] : []
        } catch {
          return []
        }
      })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${label} log could not be read: ${path}: ${cause}\n` +
        `cleared by: make ${path} readable or remove it so a new log can be created`,
      { cause: error },
    )
  }
}

/** Read valid timestamped values from the current and previous bounded generations. */
export function readBoundedJsonLinesSince<T extends { at: string }>(
  since: string,
  parse: (value: unknown) => T | null,
  options: Pick<BoundedLogOptions, 'env' | 'name'> & { label: string },
): T[] {
  const sinceMs = Date.parse(since)
  if (!Number.isFinite(sinceMs)) {
    throw new Error(
      `${options.label} log start time could not be parsed: ${since}\n` +
        'cleared by: provide since as an ISO 8601 timestamp',
    )
  }
  const paths = logPaths(options.name, options.env ?? process.env)
  return [
    ...readLog(paths.previous, options.label, parse),
    ...readLog(paths.current, options.label, parse),
  ]
    .filter((entry) => Date.parse(entry.at) >= sinceMs)
    .sort((left, right) => left.at.localeCompare(right.at))
}
