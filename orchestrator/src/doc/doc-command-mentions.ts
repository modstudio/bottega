// concern: doc-command-mentions
/** Pure detection of unknown command mentions in customer guide Markdown. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type UnknownCommandMention = {
  mention: string
}

const COMMAND_PREFIXES = [PLATFORM_SLUG, 'orch', 'hub'] as const
type Fence = { marker: '`' | '~'; length: number }

function commandTokens(text: string): string[] {
  const tokens = text.trim().split(/\s+/)
  if (!COMMAND_PREFIXES.includes(tokens[0] as (typeof COMMAND_PREFIXES)[number])) return []
  const command: string[] = []
  for (const token of tokens) {
    if (
      token.startsWith('-') ||
      token.startsWith('<') ||
      token.startsWith('[') ||
      token.includes('=') ||
      /^[A-Z][A-Z0-9_-]*$/.test(token)
    )
      break
    if (!/^\w[\w-]*$/.test(token)) break
    command.push(token)
  }
  return command.length > 1 ? command : []
}

function fenceTransition(line: string, fence: Fence | null): Fence | null | undefined {
  const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
  if (!marker) return undefined
  if (!fence) return { marker: marker[0] as Fence['marker'], length: marker.length }
  if (marker[0] === fence.marker && marker.length >= fence.length) return null
  return undefined
}

function fencedCommandLines(line: string): string[] {
  return line
    .split(/\|\||&&|[|;]/)
    .map((segment) => segment.trimStart().replace(/^[$%]\s+/, ''))
    .filter((text) => COMMAND_PREFIXES.some((prefix) => text.startsWith(`${prefix} `)))
}

function markdownCommandLines(body: string): string[] {
  const mentions: string[] = []
  let fence: Fence | null = null
  for (const line of body.split('\n')) {
    const transitioned = fenceTransition(line, fence)
    if (transitioned !== undefined) {
      fence = transitioned
      continue
    }
    if (fence) mentions.push(...fencedCommandLines(line))
    else for (const match of line.matchAll(/`([^`\n]+)`/g)) mentions.push(match[1]!)
  }
  return mentions
}

function unknownBottegaMention(tokens: string[], known: ReadonlySet<string>): string | null {
  const words = tokens.slice(1)
  let matched = ''
  for (let length = words.length; length > 0; length -= 1) {
    const candidate = `${PLATFORM_SLUG} ${words.slice(0, length).join(' ')}`
    if (known.has(candidate)) {
      matched = candidate
      break
    }
  }
  if (!matched) return `${PLATFORM_SLUG} ${words[0]}`
  const matchedLength = matched.split(' ').length - 1
  const next = words[matchedLength]
  if (!next) return null
  const hasSubcommands = [...known].some((command) => command.startsWith(`${matched} `))
  return hasSubcommands ? `${matched} ${next}` : null
}

/** Returns each distinct unknown or retired command mention in source order. */
export function unknownCommandMentions(
  body: string,
  knownCommands: readonly string[],
): UnknownCommandMention[] {
  const known = new Set(knownCommands)
  const findings: UnknownCommandMention[] = []
  const seen = new Set<string>()
  for (const text of markdownCommandLines(body)) {
    const tokens = commandTokens(text)
    if (!tokens.length) continue
    const prefix = tokens[0]!
    const mention =
      prefix === PLATFORM_SLUG ? unknownBottegaMention(tokens, known) : tokens.join(' ')
    if (!mention || seen.has(mention)) continue
    seen.add(mention)
    findings.push({ mention })
  }
  return findings
}
