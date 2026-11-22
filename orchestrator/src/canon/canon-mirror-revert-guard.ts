// concern: canon-mirror-revert-guard
/** Refuses a hydration operation that would erase canon committed after its store history. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type CanonMirrorGuardInput = {
  project: string
  path: string
  operation: 'write' | 'delete'
  commit: { sha: string; at: string } | null
  rowRevisionAt: string | null
  removalAt: string | null
  newestCanonAt: string | null
}

export function canonMirrorRevertRefusal(input: CanonMirrorGuardInput): string | null {
  if (!input.commit) return null
  const storeAt =
    input.operation === 'write'
      ? input.rowRevisionAt
      : (input.removalAt ?? (input.rowRevisionAt === null ? input.newestCanonAt : null))
  if (!storeAt || Date.parse(input.commit.at) <= Date.parse(storeAt)) return null
  const short = input.commit.sha.slice(0, 10)
  return (
    `refusing canon mirror change to ${input.path}: base commit ${short} is newer than the store history; ` +
    `adopt it with: ${PLATFORM_SLUG} doc set --scope canon --subject ${input.project} ` +
    `--slug ${input.path} --file ${input.path}`
  )
}
