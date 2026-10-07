// concern: tree database connection classification
/** Classifies sampled database sessions from plain values without observing a server or clock. */

import type { RecipeDatabaseConnectionRow } from '../recipe/database-connection-observation.ts'
import type { MonitorCondition } from './monitor-types.ts'

export type TreeDatabaseOwner = { database: string; ownerLabel: string }

type OffenseKind = 'cross-tree-database-connection' | 'untagged-tree-database-connection'

type Offense = { kind: OffenseKind; applicationName: string }

function offense(applicationName: string, ownerLabel: string): Offense | null {
  if (applicationName === 'orch-admin' || applicationName === `orch-tree-${ownerLabel}`) return null
  return applicationName.startsWith('orch-tree-')
    ? { kind: 'cross-tree-database-connection', applicationName }
    : { kind: 'untagged-tree-database-connection', applicationName }
}

function applicationSummary(applications: Map<string, number>): string {
  return [...applications.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name || '(empty)'} (${count})`)
    .join(', ')
}

/** Return one report-only condition for each offending database and offense kind. */
export function treeDatabaseConnectionConditions(input: {
  project: string
  allocationKey: string
  rows: readonly RecipeDatabaseConnectionRow[]
  owners: readonly TreeDatabaseOwner[]
}): MonitorCondition[] {
  const owners = new Map(input.owners.map((owner) => [owner.database, owner.ownerLabel]))
  const grouped = new Map<
    string,
    { database: string; ownerLabel: string; kind: OffenseKind; applications: Map<string, number> }
  >()
  for (const row of input.rows) {
    const ownerLabel = owners.get(row.datname)
    if (!ownerLabel) continue
    const classified = offense(row.applicationName, ownerLabel)
    if (!classified) continue
    const key = `${row.datname}\0${classified.kind}`
    const group = grouped.get(key) ?? {
      database: row.datname,
      ownerLabel,
      kind: classified.kind,
      applications: new Map<string, number>(),
    }
    group.applications.set(
      classified.applicationName,
      (group.applications.get(classified.applicationName) ?? 0) + 1,
    )
    grouped.set(key, group)
  }
  return [...grouped.values()].map((group) => {
    const count = [...group.applications.values()].reduce((total, value) => total + value, 0)
    return {
      kind: group.kind,
      subject: `${input.project}:${input.allocationKey}:postgres:${group.database}`,
      since: null,
      ageMs: null,
      detail: `${input.project} allocation ${input.allocationKey} database ${group.database} owned by ${group.ownerLabel} has ${count} ${group.kind} sample row(s); offending application_name: ${applicationSummary(group.applications)}`,
      action: 'report only',
      affectedProject: input.project,
    }
  })
}
