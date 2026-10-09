import {
  HOSTED_CHANGE_EVIDENCE_KINDS,
  type HostedChangeEvidenceFilters,
  type HostedChangeEvidenceKind,
  listHostedChangeEvidence,
  summarizeHostedChangeEvidence,
} from './hosted-change-evidence.ts'
import { HOSTED_CHANGE_FAMILIES, type HostedChangeFamilyName } from './hosted-change-family.ts'

export const HOSTED_CHANGE_EVIDENCE_USAGE =
  'hub changes [--family task|note] [--space ID] [--kind changed-upsert|applied-delete|skipped-delete] [--summary] [--json]'

function flag(argv: string[], name: string) {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}

function filters(argv: string[]): HostedChangeEvidenceFilters {
  const family = flag(argv, 'family')
  if (family !== undefined && !HOSTED_CHANGE_FAMILIES.includes(family as HostedChangeFamilyName))
    throw new Error('--family must be task or note')
  const kind = flag(argv, 'kind')
  if (
    kind !== undefined &&
    !HOSTED_CHANGE_EVIDENCE_KINDS.includes(kind as HostedChangeEvidenceKind)
  )
    throw new Error('--kind must be changed-upsert, applied-delete, or skipped-delete')
  return {
    family: family as HostedChangeFamilyName | undefined,
    space: flag(argv, 'space'),
    kind: kind as HostedChangeEvidenceKind | undefined,
  }
}

export function runHostedChangeEvidenceCommand(argv: string[]): string[] {
  const selected = filters(argv)
  const json = argv.includes('--json')
  if (argv.includes('--summary')) {
    return summaryLines(selected, json)
  }
  return eventLines(selected, json)
}

function summaryLines(selected: HostedChangeEvidenceFilters, json: boolean): string[] {
  const rows = summarizeHostedChangeEvidence(selected)
  if (json)
    return [
      JSON.stringify(
        rows.map((row) => ({
          table: row.table,
          differing_columns: row.differingColumns,
          count: row.count,
        })),
      ),
    ]
  if (!rows.length) return ['no hosted change evidence']
  return rows.map((row) => {
    const columns = row.differingColumns.join(',') || '(none)'
    return `${row.table}  ${columns}  ${row.count}`
  })
}

function eventLines(selected: HostedChangeEvidenceFilters, json: boolean): string[] {
  const rows = listHostedChangeEvidence(selected)
  if (json)
    return [
      JSON.stringify(
        rows.map((row) => ({
          observed_at: row.observedAt,
          family: row.family,
          space_id: row.spaceId,
          table: row.table,
          row_id: row.rowId,
          kind: row.kind,
          differing_columns: row.differingColumns,
        })),
      ),
    ]
  if (!rows.length) return ['no hosted change evidence']
  return rows.map((row) => {
    const columns = row.differingColumns.length ? `  columns ${row.differingColumns.join(',')}` : ''
    return `${row.observedAt}  ${row.family}  ${row.spaceId}  ${row.table}  ${row.rowId}  ${row.kind}${columns}`
  })
}
