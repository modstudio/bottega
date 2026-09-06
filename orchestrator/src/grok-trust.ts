import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function grokTrustStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GROK_HOME ?? join(homedir(), '.grok'), 'trusted_folders.toml')
}

/**
 * Observation only. Grok owns this file; orch neither parses nor edits it.
 * A heading is the text of a line beginning with `[folders.`, without its line
 * terminator, so every other byte in the vendor store remains irrelevant.
 */
export function grokTrustHeadings(env: NodeJS.ProcessEnv = process.env): string[] {
  const path = grokTrustStorePath(env)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/)
      .filter((line) => line.startsWith('[folders.'))
  } catch {
    // Trust-store observation must never turn a vendor grant into a run failure.
    return []
  }
}

export function addedGrokTrustHeadings(before: string[], after: string[]): string[] {
  const remaining = new Map<string, number>()
  for (const heading of before) remaining.set(heading, (remaining.get(heading) ?? 0) + 1)
  return after.filter((heading) => {
    const count = remaining.get(heading) ?? 0
    if (!count) return true
    remaining.set(heading, count - 1)
    return false
  })
}

/** Sweep's deliberately shallow extraction: first quote to last matching quote. */
export function grokTrustPathFromHeading(heading: string): string | null {
  const double = heading.indexOf('"')
  const single = heading.indexOf("'")
  const first = double < 0 ? single : single < 0 ? double : Math.min(double, single)
  if (first < 0) return null
  const quote = heading[first]!
  const last = heading.lastIndexOf(quote)
  return last > first ? heading.slice(first + 1, last) : null
}
