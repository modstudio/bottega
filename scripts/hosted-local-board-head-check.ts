import { hostedTableInSql } from '../orchestrator/src/database/hosted-table-guard.ts'
import {
  classifyHostedLocalReadSites,
  type HostedLocalReadCandidate,
  hostedLocalReadSourceFacts,
} from './hosted-local-read-report.ts'
import { HOSTED_LOCAL_SQL_ALLOWED_FILES } from './hosted-local-sql-allowlist.ts'
import { extractSqlFromSource } from './hosted-sql-schema.ts'
import { STATE_CLASSES } from './identity-state-classes.ts'
import { isProductionTypeScriptFile } from './typescript-source-files.ts'

export function hostedLocalBoardHeadFailures(input: {
  file: string
  sourceText: string
}): string[] {
  if (!isProductionTypeScriptFile(input.file)) return []
  const tables = STATE_CLASSES.flatMap((item) =>
    'table' in item &&
    item.store === 'orchestrator' &&
    item.class === 'hosted' &&
    item.table.startsWith('board_')
      ? [
          {
            table: item.table,
            cache: item.cache === true,
            ...(item.task ? { task: item.task } : {}),
          },
        ]
      : [],
  )
  const tableNames = tables.map(({ table }) => table)
  const sourceFacts = hostedLocalReadSourceFacts(input.sourceText)
  const extracted = extractSqlFromSource({
    sourceText: input.sourceText,
    file: input.file,
    renderedUnresolvedRisk: (sql) => hostedTableInSql(sql, tableNames) !== null,
  })
  const candidates: HostedLocalReadCandidate[] = [
    ...extracted.sites.map((site) => ({ ...site, ...sourceFacts, sourceText: input.sourceText })),
    ...extracted.unresolved.map((site) => ({
      ...site,
      ...sourceFacts,
      sourceText: input.sourceText,
    })),
    ...extracted.cannotJudge.map((site) => ({
      ...site,
      ...sourceFacts,
      sourceText: input.sourceText,
      dynamicTable: true,
    })),
  ]
  return classifyHostedLocalReadSites({
    candidates,
    tables,
    allowedFiles: HOSTED_LOCAL_SQL_ALLOWED_FILES,
  }).flatMap((hit) =>
    (hit.path === 'cannot-tell' || hit.path === 'hosted-reachable') &&
    hit.exclusionReason !== 'planned'
      ? [
          `${hit.file}:${hit.line}: local ${hit.table} ${hit.kind} has no proven local-board head; add a requireLocalBoardRead/requireLocalBoardWrite head, or an allowlist entry naming its task`,
        ]
      : [],
  )
}
