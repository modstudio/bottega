import { type HostedLocalReadHit, scanHostedLocalReadSource } from './hosted-local-read-report.ts'
import { isProductionTypeScriptFile } from './typescript-source-files.ts'

export function hostedLocalBoardHeadFailures(input: {
  file: string
  sourceText: string
}): string[] {
  if (!isProductionTypeScriptFile(input.file)) return []
  return hostedLocalBoardHitFailures(
    scanHostedLocalReadSource({
      sourceText: input.sourceText,
      file: input.file,
      concern: 'orchestrator',
    }),
  )
}

/** The one board-head judgment shared by the whole-tree gate and the write-time hook. */
export function hostedLocalBoardHitFailures(hits: readonly HostedLocalReadHit[]): string[] {
  return hits.flatMap((hit) =>
    (hit.path === 'cannot-tell' || hit.path === 'hosted-reachable') &&
    hit.table.startsWith('board_') &&
    hit.exclusionReason === undefined
      ? [
          `${hit.file}:${hit.line}: local ${hit.table} ${hit.kind} has no proven local-board head; add a requireLocalBoardRead/requireLocalBoardWrite head, or an allowlist entry naming its task`,
        ]
      : [],
  )
}
