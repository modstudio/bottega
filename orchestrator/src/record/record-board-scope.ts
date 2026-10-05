// concern: record-board-scope
/** Pure hosted board scope, identity, and create-content decisions. Must not know SQL. */

import { type Audience, parseAudience } from '../board/board-policy.ts'
import { senderTagKey } from '../board/board-tags.ts'
import { type HostedBoardCreateContent, RecordBoardError } from './record-board-contract.ts'

export function parseHostedAudience(expression: string): Audience {
  try {
    return parseAudience(expression)
  } catch (error) {
    throw new RecordBoardError(error instanceof Error ? error.message : String(error), 400)
  }
}

export function hostedBoardActor(
  session: string | null | undefined,
): { kind: 'operator'; session: null } | { kind: 'architect'; session: string } {
  const value = session?.trim()
  if (!value) return { kind: 'operator', session: null }
  return { kind: 'architect', session: value }
}

export function hostedBoardPostRefusal(kind: string, audience: Audience): string | null {
  if (kind === 'suggestion')
    return 'hosted board refuses suggestions; a worker suggestion stays on its machine'
  if (audience.kind === 'machine')
    return 'hosted board refuses machine audiences; machine messages stay on their machine'
  return null
}

export function hostedProjectNameForAudience(
  audience: Audience,
  project: string | undefined,
): string | null {
  if (audience.kind === 'project' || audience.kind === 'workers') return audience.value
  if (audience.kind === 'task') return project?.trim() || null
  return null
}

export function hostedBoardScope(
  audience: Audience,
  projectId: string | null,
): { scopeProjectIds: string[]; recipientUserIds: string[] } {
  if (audience.kind === 'project' || audience.kind === 'workers' || audience.kind === 'task') {
    return { scopeProjectIds: projectId ? [projectId] : [], recipientUserIds: [] }
  }
  return { scopeProjectIds: [], recipientUserIds: [] }
}

function isoOrNull(value: string | null): string | null {
  return value == null ? null : new Date(value).toISOString()
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const ordered = [...left].sort()
  return [...right].sort().every((id, index) => id === ordered[index])
}

function uuidFromBytes(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function uuidEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim().replace(/^"|"$/g, '').toLowerCase()
  if (entry instanceof Uint8Array && entry.length === 16) return uuidFromBytes(entry)
  return String(entry).trim().replace(/^"|"$/g, '').toLowerCase()
}

/** Decodes a hosted uuid[] column from bun, PGlite, or a Postgres array literal. */
export function hostedUuidList(value: unknown): string[] {
  if (value == null) return []
  if (typeof value === 'string') {
    const inner = value.trim().replace(/^\{|\}$/g, '')
    if (!inner) return []
    return inner.split(',').map(uuidEntry)
  }
  if (!Array.isArray(value)) return []
  return value.map(uuidEntry)
}

export function sameHostedBoardCreateContent(
  stored: HostedBoardCreateContent,
  requested: HostedBoardCreateContent,
): boolean {
  return (
    stored.kind === requested.kind &&
    stored.audience === requested.audience &&
    stored.title === requested.title &&
    stored.body === requested.body &&
    stored.ackRequired === requested.ackRequired &&
    isoOrNull(stored.ackDeadline) === isoOrNull(requested.ackDeadline) &&
    isoOrNull(stored.expiresAt) === isoOrNull(requested.expiresAt) &&
    stored.threadRootId === requested.threadRootId &&
    stored.claimId === requested.claimId &&
    sameIds(stored.scopeProjectIds, requested.scopeProjectIds) &&
    sameIds(stored.recipientUserIds, requested.recipientUserIds) &&
    senderTagKey(stored.senderTags) === senderTagKey(requested.senderTags)
  )
}
