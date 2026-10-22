// concern: record-projects
/** Owns tenant-bound hosted project reads and writes. Must not know local cache, CLI, or HTTP. */
import { SQL } from 'bun'
import { bindJsonb } from '../../../shared/record/jsonb-sql.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import {
  type HostedProjectColumns,
  hostedProjectColumns,
  hostedProjectSettings,
} from './record-project-columns.ts'

export type RecordProjectUpsertInput = {
  id: string
  name: string
  path: string
  stack: string | null
  canon: boolean
  settings: Record<string, unknown>
  retiredAt: string | null
}

export class RecordProjectError extends Error {
  status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

type Tenant = { url: string } & TenantPrincipal

async function tenant<T>(input: Tenant, read: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

async function renameHostedDocSubjects(
  tx: SQL,
  spaceId: string,
  projectId: string,
  from: string,
  to: string,
): Promise<void> {
  await tx`
    UPDATE doc SET subject=${to}, updated_at=now()
    WHERE space_id=${spaceId}::uuid AND subject=${from}
      AND project_id=${projectId}::uuid
  `
  await tx`
    UPDATE doc_revision SET subject=${to}
    WHERE space_id=${spaceId}::uuid AND subject=${from}
      AND project_id=${projectId}::uuid
  `
}

const HUB_PROJECT_NAME_TABLES = [
  'hub_task',
  'hub_task_comment',
  'hub_task_document',
  'hub_task_status_event',
  'hub_note',
  'hub_note_acknowledgement',
  'hub_report_subscription',
  'hub_report_subscription_project',
  'hub_interval',
] as const

async function renameHostedHubProjectNames(
  tx: SQL,
  input: { spaceId: string; projectId: string; from: string; to: string },
): Promise<void> {
  for (const table of HUB_PROJECT_NAME_TABLES) {
    await tx`UPDATE ${tx.unsafe(table)} SET project_name=${input.to}
      WHERE project_id=${input.projectId}::uuid`
  }
  await tx`
    UPDATE hub_task SET project=${input.to}
    WHERE project_id=${input.projectId}::uuid
  `
  await tx`
    UPDATE hub_note SET project=${input.to}
    WHERE project_id=${input.projectId}::uuid
  `
}

function postgresTextArray(sql: Pick<SQL, 'array'>, value: string[] | null) {
  if (value === null) return null
  return sql.array(value, 'text')
}

export async function upsertHostedProjectRow(
  tx: SQL,
  input: {
    spaceId: string
    name: string
    path: string
    stack: string | null
    canon: boolean
    retiredAt: string | null
    columns: HostedProjectColumns
    id: string
  },
): Promise<string> {
  const id = input.id
  const columns = input.columns
  const rows = await tx`
    INSERT INTO project (
      id, space_id, name, key_prefixes, checkout_path, stack, canon, managed_context,
      landing_branch, production_branch, gate, gate_input, focused_tests, require_clean_main, color,
      color_dark, env_prefix, mcp_server, worker_mcp_servers, secret_paths,
      mcp_probe_tool, mcp_reader_tools, docs, reference, signals, review, test_substance, mechanical_checks, release, states, tracker, worktree, retired_at, created_at
    ) VALUES (
      ${id}::uuid, ${input.spaceId}::uuid, ${input.name}, ${tx.array(columns.keyPrefixes, 'text')},
      ${input.path}, ${input.stack}, ${input.canon}, ${columns.managedContext},
      ${columns.landingBranch}, ${columns.productionBranch}, ${columns.gate}, ${columns.gateInput},
      ${bindJsonb(tx, columns.focusedTests)},
      ${columns.requireCleanMain}, ${columns.color}, ${columns.colorDark}, ${columns.envPrefix},
      ${columns.mcpServer}, ${postgresTextArray(tx, columns.workerMcpServers)},
      ${postgresTextArray(tx, columns.secretPaths)}, ${columns.mcpProbeTool},
      ${bindJsonb(tx, columns.mcpReaderTools)},
      ${bindJsonb(tx, columns.docs)},
      ${bindJsonb(tx, columns.reference)},
      ${bindJsonb(tx, columns.signals)},
      ${bindJsonb(tx, columns.review)},
      ${bindJsonb(tx, columns.testSubstance)},
      ${bindJsonb(tx, columns.mechanicalChecks)},
      ${bindJsonb(tx, columns.release)},
      ${bindJsonb(tx, columns.states)},
      ${bindJsonb(tx, columns.tracker)},
      ${bindJsonb(tx, columns.worktree)},
      ${input.retiredAt},
      now()
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      key_prefixes = EXCLUDED.key_prefixes,
      checkout_path = EXCLUDED.checkout_path,
      stack = EXCLUDED.stack,
      canon = EXCLUDED.canon,
      managed_context = EXCLUDED.managed_context,
      landing_branch = EXCLUDED.landing_branch,
      production_branch = EXCLUDED.production_branch,
      gate = EXCLUDED.gate,
      gate_input = EXCLUDED.gate_input,
      focused_tests = EXCLUDED.focused_tests,
      require_clean_main = EXCLUDED.require_clean_main,
      color = EXCLUDED.color,
      color_dark = EXCLUDED.color_dark,
      env_prefix = EXCLUDED.env_prefix,
      mcp_server = EXCLUDED.mcp_server,
      worker_mcp_servers = EXCLUDED.worker_mcp_servers,
      secret_paths = EXCLUDED.secret_paths,
      mcp_probe_tool = EXCLUDED.mcp_probe_tool,
      mcp_reader_tools = EXCLUDED.mcp_reader_tools,
      docs = EXCLUDED.docs,
      reference = EXCLUDED.reference,
      signals = EXCLUDED.signals,
      review = EXCLUDED.review,
      test_substance = EXCLUDED.test_substance,
      mechanical_checks = EXCLUDED.mechanical_checks,
      release = EXCLUDED.release,
      states = EXCLUDED.states,
      tracker = EXCLUDED.tracker,
      worktree = EXCLUDED.worktree,
      retired_at = EXCLUDED.retired_at
    RETURNING id
  `
  return String(rows[0]!.id)
}

export async function listRecordProjects(
  input: { url: string } & TenantPrincipal,
): Promise<RecordProject[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`SELECT p.*, s.name AS space_name
        FROM project p JOIN space s ON s.id=p.space_id ORDER BY s.name,p.name`
    return rows.map((row: Record<string, unknown>) => {
      const columns: HostedProjectColumns = {
        keyPrefixes: row.key_prefixes as string[],
        managedContext: row.managed_context === true,
        landingBranch: row.landing_branch == null ? null : String(row.landing_branch),
        productionBranch: row.production_branch == null ? null : String(row.production_branch),
        gate: row.gate == null ? null : String(row.gate),
        gateInput: row.gate_input == null ? null : String(row.gate_input),
        focusedTests: row.focused_tests as HostedProjectColumns['focusedTests'],
        requireCleanMain: row.require_clean_main !== false,
        color: row.color == null ? null : String(row.color),
        colorDark: row.color_dark == null ? null : String(row.color_dark),
        envPrefix: row.env_prefix == null ? null : String(row.env_prefix),
        mcpServer: row.mcp_server == null ? null : String(row.mcp_server),
        workerMcpServers: row.worker_mcp_servers as string[] | null,
        secretPaths: row.secret_paths as string[] | null,
        mcpProbeTool: row.mcp_probe_tool == null ? null : String(row.mcp_probe_tool),
        mcpReaderTools: row.mcp_reader_tools as HostedProjectColumns['mcpReaderTools'],
        docs: row.docs as HostedProjectColumns['docs'],
        reference: row.reference as HostedProjectColumns['reference'],
        signals: row.signals as HostedProjectColumns['signals'],
        review: row.review as HostedProjectColumns['review'],
        testSubstance: row.test_substance as HostedProjectColumns['testSubstance'],
        mechanicalChecks: row.mechanical_checks as HostedProjectColumns['mechanicalChecks'],
        release: row.release as HostedProjectColumns['release'],
        states: row.states as HostedProjectColumns['states'],
        tracker: row.tracker as HostedProjectColumns['tracker'],
        worktree: row.worktree as HostedProjectColumns['worktree'],
      }
      return {
        id: String(row.id),
        spaceId: String(row.space_id),
        spaceName: String(row.space_name),
        name: String(row.name),
        keyPrefixes: columns.keyPrefixes,
        stack: row.stack == null ? null : String(row.stack),
        managedContext: columns.managedContext,
        landingBranch: columns.landingBranch,
        color: columns.color,
        colorDark: columns.colorDark,
        retiredAt: row.retired_at == null ? null : new Date(String(row.retired_at)).toISOString(),
        canon: row.canon === true,
        settings: hostedProjectSettings(columns),
      }
    })
  })
}

export async function upsertRecordProject(
  input: Tenant & RecordProjectUpsertInput,
): Promise<{ id: string; name: string }> {
  try {
    return await tenant(input, async (tx) => {
      const nextName = input.name
      const currentRows = await tx`
      SELECT id, name FROM project
      WHERE id=${input.id}::uuid
    `
      const currentName = currentRows[0]?.name == null ? null : String(currentRows[0].name)
      let columns: HostedProjectColumns
      try {
        columns = hostedProjectColumns(input.settings, nextName)
      } catch (error) {
        throw new RecordProjectError(error instanceof Error ? error.message : String(error), 400)
      }
      if (currentName !== null && currentName !== nextName) {
        await tx`UPDATE project SET name=${nextName} WHERE id=${input.id}::uuid`
        await renameHostedHubProjectNames(tx, {
          spaceId: input.spaceId,
          projectId: input.id,
          from: currentName,
          to: nextName,
        })
        await renameHostedDocSubjects(tx, input.spaceId, input.id, currentName, nextName)
      }
      const id = await upsertHostedProjectRow(tx, {
        spaceId: input.spaceId,
        id: input.id,
        name: nextName,
        path: input.path,
        stack: input.stack,
        canon: input.canon,
        retiredAt: input.retiredAt,
        columns,
      })
      return { id, name: nextName }
    })
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes('project_space_name_uq') ||
        error.message.includes('project_space_id_name_unique') ||
        error.message.includes('duplicate key value violates unique constraint'))
    ) {
      throw new RecordProjectError(
        `hosted project name "${input.name}" already exists in the request space`,
        409,
      )
    }
    throw error
  }
}

export async function retireRecordProject(
  input: Tenant & { id: string },
): Promise<{ name: string }> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      UPDATE project SET retired_at = now()
      WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid
      RETURNING name
    `
    if (!rows.length) throw new RecordProjectError(`hosted project ${input.id} not found`, 404)
    return { name: String(rows[0]!.name) }
  })
}
