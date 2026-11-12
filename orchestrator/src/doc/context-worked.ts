// concern: context-worked
/** Pure derivation and rendering of task keys worked by one architect session. */

type WorkedTaskRow = { key: string | null; at: string }

export type WorkedTaskFacts = {
  events: readonly WorkedTaskRow[]
}

export const WORKED_CONTEXT_ID = 'worked'
export const WORKED_CONTEXT_KIND = 'fact'

/** Return the newest occurrence of each non-empty task key, newest first. */
export function workedTaskKeys(facts: WorkedTaskFacts): string[] {
  const rows = facts.events.map((row, ordinal) => ({ ...row, ordinal }))
  rows.sort((left, right) => right.at.localeCompare(left.at) || left.ordinal - right.ordinal)
  const emitted = new Set<string>()
  const keys: string[] = []
  for (const row of rows) {
    const key = row.key?.trim()
    if (!key || emitted.has(key)) continue
    emitted.add(key)
    keys.push(key)
  }
  return keys
}

export function renderWorkedTaskKeys(keys: readonly string[], cap: number): string | null {
  if (keys.length === 0) return null
  const full = `Worked: ${keys.join(', ')}`
  if (full.length <= cap) return full
  for (let kept = keys.length - 1; kept >= 0; kept -= 1) {
    const omitted = keys.length - kept
    const prefix = kept > 0 ? `${keys.slice(0, kept).join(', ')}, ` : ''
    const body = `Worked: ${prefix}and ${omitted} more`
    if (body.length <= cap) return body
  }
  throw new Error(`worked fact cap ${cap} is too small for its truncation marker`)
}

export function parseWorkedTaskKeys(body: string): string[] {
  const match = /^Worked:\s*(.*)$/.exec(body)
  if (!match) return []
  return match[1]!
    .replace(/(?:,\s*)?and \d+ more$/, '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
}
