// concern: database allocation namespace matching
/** Turns one allocation template into an exact matcher without guessing unsupported placeholders. */

export type DatabaseAllocationMatcher =
  | { ok: true; matcher: RegExp }
  | { ok: false; detail: string }

const PLACEHOLDER = /\{([^{}]+)\}/g
const REGEXP_CHARACTER = /[\\^$.*+?()[\]{}|]/g

function escaped(value: string): string {
  return value.replace(REGEXP_CHARACTER, '\\$&')
}

export function databaseAllocationMatcher(template: string): DatabaseAllocationMatcher {
  const parts: string[] = []
  let offset = 0
  for (const match of template.matchAll(PLACEHOLDER)) {
    const placeholder = match[1]!
    if (placeholder !== 'index') {
      return {
        ok: false,
        detail: `database allocation template "${template}" contains unsupported placeholder {${placeholder}}; use only {index} to make its namespace observable`,
      }
    }
    parts.push(escaped(template.slice(offset, match.index)), '\\d+')
    offset = match.index + match[0].length
  }
  parts.push(escaped(template.slice(offset)))
  return { ok: true, matcher: new RegExp(`^${parts.join('')}$`) }
}
