import { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { newRecordId } from './postgres-schema.ts'

type SourceProject = {
  id: number
  name: string
  path: string
  stack: string | null
  canon: number
  settings: string | null
}

type SourceSequence = { name: string; next: number }
type JsonObject = Record<string, unknown>

export type SequenceSkip = { name: string; next: number; reason: string }
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

const PROJECT_SETTING_KEYS = new Set([
  'color', 'colorDark', 'envPrefix', 'gate', 'keyPrefixes', 'mcp', 'mcpServer',
  'productionBranch', 'requireCleanMain', 'tracker', 'trunk', 'worktree',
])

function object(value: unknown, location: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be a JSON object`)
  }
  return value as JsonObject
}

function optionalString(value: unknown, location: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${location} must be a string`)
  return value
}

function projectSettings(row: SourceProject): JsonObject {
  if (row.settings === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(row.settings)
  } catch {
    throw new Error(`project ${row.name} settings is not valid JSON`)
  }
  const settings = object(parsed, `project ${row.name} settings`)
  const unknown = Object.keys(settings).filter((key) => !PROJECT_SETTING_KEYS.has(key))
  if (unknown.length) {
    throw new Error(`project ${row.name} has unmapped settings keys: ${unknown.sort().join(', ')}`)
  }
  return settings
}

function keyPrefixes(settings: JsonObject, project: string): string[] {
  const value = settings.keyPrefixes
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`project ${project} settings.keyPrefixes must be an array of strings`)
  }
  return value as string[]
}

function mcpProbeTool(settings: JsonObject, project: string): string | null {
  if (settings.mcp === undefined || settings.mcp === null) return null
  const mcp = object(settings.mcp, `project ${project} settings.mcp`)
  const unknown = Object.keys(mcp).filter((key) => key !== 'probe_tool')
  if (unknown.length) {
    throw new Error(`project ${project} has unmapped settings.mcp keys: ${unknown.sort().join(', ')}`)
  }
  return optionalString(mcp.probe_tool, `project ${project} settings.mcp.probe_tool`)
}

function document(value: unknown, location: string): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(object(value, location))
}

function readSources(orchDb: string, hubDb: string): {
  projects: SourceProject[]
  sequences: SourceSequence[]
} {
  const orch = new Database(orchDb, { readonly: true })
  const hub = new Database(hubDb, { readonly: true })
  try {
    return {
      projects: orch.query<SourceProject, []>(
        'SELECT id, name, path, stack, canon, settings FROM project ORDER BY id',
      ).all(),
      sequences: hub.query<SourceSequence, []>('SELECT name, next FROM seq ORDER BY name').all(),
    }
  } finally {
    orch.close()
    hub.close()
  }
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
      for (const row of source.projects) {
        const settings = projectSettings(row)
        const prefixes = keyPrefixes(settings, row.name)
        for (const prefix of prefixes) {
          prefixOwners.set(prefix, [...(prefixOwners.get(prefix) ?? []), row.name])
        }

        const existing = await tx`
          SELECT id FROM project WHERE space_id = ${options.spaceId}::uuid AND name = ${row.name}
        `
        const id = existing.length ? String(existing[0]!.id) : newRecordId()
        const tracker = document(settings.tracker, `project ${row.name} settings.tracker`)
        const worktree = document(settings.worktree, `project ${row.name} settings.worktree`)
        await tx`
          INSERT INTO project (
            id, space_id, name, key_prefixes, checkout_path, stack, canon,
            landing_branch, production_branch, gate, require_clean_main, color,
            color_dark, env_prefix, mcp_server, mcp_probe_tool, tracker,
            worktree_recipe, created_at
          ) VALUES (
            ${id}::uuid, ${options.spaceId}::uuid, ${row.name}, ${tx.array(prefixes, 'text')},
            ${row.path}, ${row.stack}, ${row.canon !== 0},
            ${optionalString(settings.trunk, `project ${row.name} settings.trunk`)},
            ${optionalString(settings.productionBranch, `project ${row.name} settings.productionBranch`)},
            ${optionalString(settings.gate, `project ${row.name} settings.gate`)},
            ${settings.requireCleanMain !== false},
            ${optionalString(settings.color, `project ${row.name} settings.color`)},
            ${optionalString(settings.colorDark, `project ${row.name} settings.colorDark`)},
            ${optionalString(settings.envPrefix, `project ${row.name} settings.envPrefix`)},
            ${optionalString(settings.mcpServer, `project ${row.name} settings.mcpServer`)},
            ${mcpProbeTool(settings, row.name)},
            (${tracker}::jsonb #>> '{}')::jsonb,
            (${worktree}::jsonb #>> '{}')::jsonb,
            now()
          )
          ON CONFLICT (space_id, name) DO UPDATE SET
            key_prefixes = EXCLUDED.key_prefixes,
            checkout_path = EXCLUDED.checkout_path,
            stack = EXCLUDED.stack,
            canon = EXCLUDED.canon,
            landing_branch = EXCLUDED.landing_branch,
            production_branch = EXCLUDED.production_branch,
            gate = EXCLUDED.gate,
            require_clean_main = EXCLUDED.require_clean_main,
            color = EXCLUDED.color,
            color_dark = EXCLUDED.color_dark,
            env_prefix = EXCLUDED.env_prefix,
            mcp_server = EXCLUDED.mcp_server,
            mcp_probe_tool = EXCLUDED.mcp_probe_tool,
            tracker = EXCLUDED.tracker,
            worktree_recipe = EXCLUDED.worktree_recipe
        `
        projectIds.set(row.name, id)
      }

      const skippedSequences: SequenceSkip[] = []
      let importedSequences = 0
      for (const sequence of source.sequences) {
        if (!sequence.name.startsWith('task:')) {
          skippedSequences.push({
            ...sequence,
            reason: 'sequence name has no task: namespace and therefore no determinate project owner',
          })
          continue
        }
        const prefix = sequence.name.slice('task:'.length)
        const owners = prefixOwners.get(prefix) ?? []
        if (owners.length !== 1) {
          const detail = owners.length ? `matched multiple projects: ${owners.join(', ')}` : 'matched no project'
          throw new Error(`cannot import sequence ${sequence.name}: ${detail}`)
        }
        const projectId = projectIds.get(owners[0]!)!
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
