// concern: prompt-retarget
/**
 * Knows confinement snapshots, the project register, and path rewriting. Must
 * not know the database, transports, contracts, or routing.
 */

import { withoutTrailingSeparators } from './checkout-identity.ts'

const UNICODE_ALPHANUMERIC_OR_MARK = /[\p{L}\p{N}\p{M}]/u
const PATH_NAME_CHARACTER = /[\p{L}\p{N}\p{M}_.-]/u
const SHELL_PATH_BOUNDARY = /[;&|<>()`$]/
const PARTIAL_FULL_CASE_FOLD = new Map([
  ['İ', 'i\u0307'],
  ['ß', 'ss'],
  ['ẞ', 'ss'],
  ['ﬀ', 'ff'],
  ['ﬁ', 'fi'],
  ['ﬂ', 'fl'],
  ['ﬃ', 'ffi'],
  ['ﬄ', 'ffl'],
  ['ﬅ', 'st'],
  ['ﬆ', 'st'],
])

function partialUnicodeCaseFold(value: string): string {
  return [...value.normalize('NFC')]
    .map((character) => PARTIAL_FULL_CASE_FOLD.get(character) ?? character.toLowerCase())
    .join('')
    .normalize('NFC')
}

function characterAt(value: string, offset: number): string | undefined {
  const point = value.codePointAt(offset)
  return point === undefined ? undefined : String.fromCodePoint(point)
}

function characterBefore(value: string, offset: number): string | undefined {
  if (offset <= 0) return undefined
  const last = value.charCodeAt(offset - 1)
  const start = last >= 0xdc00 && last <= 0xdfff ? offset - 2 : offset - 1
  return value.slice(Math.max(0, start), offset)
}

function hasPathEndBoundary(prompt: string, offset: number): boolean {
  const after = characterAt(prompt, offset)
  if (after === undefined || after === '/' || /\s/.test(after)) return true
  if (SHELL_PATH_BOUNDARY.test(after)) return true
  if (UNICODE_ALPHANUMERIC_OR_MARK.test(after)) return false
  const next = characterAt(prompt, offset + after.length)
  return next === undefined || /\s/.test(next)
}

function pathRootMatchLength(
  prompt: string,
  offset: number,
  root: string,
  caseInsensitive: boolean,
): number | null {
  if (!caseInsensitive) {
    if (prompt.slice(offset, offset + root.length) !== root) return null
    return hasPathEndBoundary(prompt, offset + root.length) ? root.length : null
  }
  const foldedRoot = partialUnicodeCaseFold(root)
  let end = offset
  while (end < prompt.length) {
    const character = characterAt(prompt, end)!
    end += character.length
    const foldedCandidate = partialUnicodeCaseFold(prompt.slice(offset, end))
    if (foldedCandidate === foldedRoot) {
      return hasPathEndBoundary(prompt, end) ? end - offset : null
    }
    const following = characterAt(prompt, end)
    if (foldedCandidate.length >= foldedRoot.length && !(following && /\p{M}/u.test(following)))
      return null
  }
  return null
}

function hasPathStartBoundary(prompt: string, offset: number): boolean {
  if (offset === 0) return true
  const before = characterBefore(prompt, offset)!
  return before !== '/' && !PATH_NAME_CHARACTER.test(before)
}

type RetargetResult = { prompt: string; diagnostic: string | null }
type RetargetAlias = { root: string; role: 'source' | 'target' }

function aliasKey(root: string, caseInsensitive: boolean): string {
  return caseInsensitive ? partialUnicodeCaseFold(root) : root
}

function invalidRetargeting(
  callers: string[],
  targets: string[],
  caseInsensitive: boolean,
): string | null {
  if (targets[0] === '') return 'review path retargeting indeterminate: destination is empty'
  const malformed = [...callers, ...targets].find((root) => root.startsWith('//'))
  if (malformed) return `review path retargeting indeterminate: unsupported alias ${malformed}`
  const normalizedCallers = callers.map(withoutTrailingSeparators)
  const normalizedTargets = targets.filter(Boolean).map(withoutTrailingSeparators)
  if (normalizedCallers.some((root) => root === '/')) {
    return 'review path retargeting indeterminate: caller alias is filesystem root (/)'
  }
  const sourceKeys = new Set(normalizedCallers.map((root) => aliasKey(root, caseInsensitive)))
  const collision = normalizedTargets.find((root) =>
    sourceKeys.has(aliasKey(root, caseInsensitive)),
  )
  return collision
    ? `review path retargeting indeterminate: alias has both source and target roles (${collision})`
    : null
}

function uriAuthorityEnd(prompt: string, offset: number): number | null {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(prompt.slice(offset))
  if (!scheme) return null
  let end = offset + scheme[0].length
  while (end < prompt.length && !/[/?#\s'"`)\]}>]/.test(prompt[end]!)) end++
  return end
}

export function retargetRepositoryPrompt(
  prompt: string,
  callers: string | string[],
  worktree: string,
  caseInsensitive: boolean,
  protectedWorktreeRoots: string[],
): RetargetResult {
  const callerList = Array.isArray(callers) ? callers : [callers]
  if (callerList.every((root) => root === '')) return { prompt, diagnostic: null }
  const rawTargets = [worktree, ...protectedWorktreeRoots]
  const invalid = invalidRetargeting(callerList, rawTargets, caseInsensitive)
  if (invalid) return { prompt, diagnostic: invalid }
  const aliases: RetargetAlias[] = [
    ...callerList
      .filter(Boolean)
      .map((root) => ({ root: withoutTrailingSeparators(root), role: 'source' as const })),
    ...rawTargets
      .filter(Boolean)
      .map((root) => ({ root: withoutTrailingSeparators(root), role: 'target' as const })),
  ]
    .filter(
      (alias, index, all) =>
        all.findIndex(
          (other) =>
            other.role === alias.role &&
            aliasKey(other.root, caseInsensitive) === aliasKey(alias.root, caseInsensitive),
        ) === index,
    )
    .sort(
      (a, b) => aliasKey(b.root, caseInsensitive).length - aliasKey(a.root, caseInsensitive).length,
    )
  const destination = withoutTrailingSeparators(worktree)
  let rewritten = ''
  let cursor = 0
  let authorityPathStart: number | null = null
  while (cursor < prompt.length) {
    const uriEnd = uriAuthorityEnd(prompt, cursor)
    if (uriEnd !== null) {
      rewritten += prompt.slice(cursor, uriEnd)
      cursor = uriEnd
      authorityPathStart = uriEnd
      continue
    }
    if (cursor !== authorityPathStart && !hasPathStartBoundary(prompt, cursor)) {
      rewritten += prompt[cursor++]
      continue
    }
    authorityPathStart = null
    const matched = aliases
      .map((alias) => ({
        alias,
        length: pathRootMatchLength(prompt, cursor, alias.root, caseInsensitive),
      }))
      .find(({ length }) => length !== null)
    if (matched) {
      const { alias, length } = matched
      rewritten +=
        alias.role === 'source'
          ? destination === '/' && prompt[cursor + length!] === '/'
            ? ''
            : destination
          : prompt.slice(cursor, cursor + length!)
      cursor += length!
      continue
    }
    rewritten += prompt[cursor++]
  }
  return { prompt: rewritten, diagnostic: null }
}

export function retargetRepositoryPromptForDispatch(
  prompt: string,
  callers: string | string[],
  worktree: string,
  caseInsensitive: boolean,
  protectedWorktreeRoots: string[],
): string {
  const result = retargetRepositoryPrompt(
    prompt,
    callers,
    worktree,
    caseInsensitive,
    protectedWorktreeRoots,
  )
  if (result.diagnostic) throw new Error(result.diagnostic)
  return result.prompt
}
