import { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { hostedProjectColumns } from '../record/record-project-columns.ts'
import { upsertHostedProjectRow } from '../record/record-projects.ts'

export { PROJECT_SETTINGS_NOT_IMPORTED } from '../record/record-project-columns.ts'

type SourceProject = {
  id: number
  name: string
  path: string
  stack: string | null
  canon: number
  settings: string | null
  retired_at: string | null
}

type SourceSequence = { name: string; next: number }
type JsonObject = Record<string, unknown>

type SequenceSkip = { name: string; next: number; reason: string }
export type ProjectImportResult = {
  projects: number
  sequences: number
  skippedSequences: SequenceSkip[]
}

export type ProjectImportOptions = {
  orchDb: string
  hubDb: string
  databaseUrl: string
  spaceId: string
}

function object(value: unknown, location: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be a JSON object`)
  }
  return value as JsonObject
}

function projectSettings(row: SourceProject): JsonObject {
  if (row.settings === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(row.settings)
  } catch {
    throw new Error(`project ${row.name} settings is not valid JSON`)
  }
  return object(parsed, `project ${row.name} settings`)
}

function readSources(
  orchDb: string,
  hubDb: string,
): {
  projects: SourceProject[]
  sequences: SourceSequence[]
} {
  const orch = new Database(orchDb, { readonly: true })
  const hub = new Database(hubDb, { readonly: true })
  try {
    return {
      projects: orch
        .query<SourceProject, []>(
          'SELECT id, name, path, stack, canon, settings, retired_at FROM project ORDER BY id',
        )
        .all(),
      sequences: hub.query<SourceSequence, []>('SELECT name, next FROM seq ORDER BY name').all(),
    }
  } finally {
    orch.close()
    hub.close()
  }
}

function sequenceImportDecision(
  sequence: SourceSequence,
  prefixOwners: Map<string, string[]>,
  retiredPrefixOwners: Map<string, string[]>,
): { owner: string } | { skip: SequenceSkip } {
  if (!sequence.name.startsWith('task:')) {
    return {
      skip: {
        ...sequence,
        reason: 'sequence name has no task: namespace and therefore no determinate project owner',
      },
    }
  }
  const prefix = sequence.name.slice('task:'.length)
  const owners = prefixOwners.get(prefix) ?? []
  const retiredOwners = retiredPrefixOwners.get(prefix) ?? []
  if (owners.length === 0 && retiredOwners.length > 0) {
    return {
      skip: {
        ...sequence,
        reason: `prefix is owned only by retired project${retiredOwners.length === 1 ? '' : 's'}: ${retiredOwners.join(', ')}`,
      },
    }
  }
  if (owners.length !== 1) {
    const detail = owners.length
      ? `matched multiple projects: ${owners.join(', ')}`
      : 'matched no project'
    throw new Error(`cannot import sequence ${sequence.name}: ${detail}`)
  }
  return { owner: owners[0]! }
}

export async function importProjects(options: ProjectImportOptions): Promise<ProjectImportResult> {
  if (!options.spaceId) throw new Error('spaceId is required')
  const source = readSources(options.orchDb, options.hubDb)
  const postgres = new SQL(options.databaseUrl)
  try {
    return await postgres.begin(async (tx) => {
      await tx`SELECT set_config('app.space_id', ${options.spaceId}, true)`
      const spaces = await tx`SELECT id FROM space WHERE id = ${options.spaceId}::uuid`
      if (spaces.length !== 1) throw new Error(`target space does not exist: ${options.spaceId}`)

      const projectIds = new Map<string, string>()
      const prefixOwners = new Map<string, string[]>()
      const retiredPrefixOwners = new Map<string, string[]>()
      for (const row of source.projects) {
        const settings = projectSettings(row)
        const columns = hostedProjectColumns(settings, row.name)
        for (const prefix of columns.keyPrefixes) {
          const owners = row.retired_at === null ? prefixOwners : retiredPrefixOwners
          owners.set(prefix, [...(owners.get(prefix) ?? []), row.name])
        }
        const id = await upsertHostedProjectRow(tx, {
          spaceId: options.spaceId,
          name: row.name,
          path: row.path,
          stack: row.stack,
          canon: row.canon !== 0,
          retiredAt: row.retired_at,
          columns,
        })
        projectIds.set(row.name, id)
      }

      const skippedSequences: SequenceSkip[] = []
      let importedSequences = 0
      for (const sequence of source.sequences) {
        const decision = sequenceImportDecision(sequence, prefixOwners, retiredPrefixOwners)
        if ('skip' in decision) {
          skippedSequences.push(decision.skip)
          continue
        }
        const projectId = projectIds.get(decision.owner)!
        await tx`
          INSERT INTO seq (space_id, project_id, name, next)
          VALUES (${options.spaceId}::uuid, ${projectId}::uuid, ${sequence.name}, ${sequence.next})
          ON CONFLICT (space_id, project_id, name) DO UPDATE SET next = EXCLUDED.next
        `
        importedSequences++
      }

      return { projects: source.projects.length, sequences: importedSequences, skippedSequences }
    })
  } finally {
    await postgres.close()
  }
}
