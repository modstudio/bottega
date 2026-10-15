// concern: record-projects
/** Owns tenant-bound hosted project reads and writes. Must not know local cache, CLI, or HTTP. */
import { SQL } from 'bun'
import { DOC_SCOPE_SUBJECT_KIND } from '../../../shared/docs.ts'
import { bindJsonb } from '../../../shared/record/jsonb-sql.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { type HostedProjectColumns, hostedProjectColumns } from './record-project-columns.ts'
import { decideHostedProjectWrite, type HostedProjectNameRow } from './record-project-write.ts'

export type RecordProject = {
  id: string
  spaceId: string
  spaceName: string
  name: string
  keyPrefixes: string[]
  stack: string | null
  managedContext: boolean
  landingBranch: string | null
  color: string | null
  colorDark: string | null
  retiredAt: string | null
}

export type RecordProjectUpsertInput = {
  id?: string
  name: string
  previousName?: string
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

function namedRow(row: Record<string, unknown> | undefined): HostedProjectNameRow | null {
  if (!row) return null
  return {
    id: String(row.id),
    name: String(row.name),
    retiredAt: row.retired_at == null ? null : new Date(String(row.retired_at)).toISOString(),
    checkoutPath: row.checkout_path == null ? null : String(row.checkout_path),
  }
}

async function renameHostedDocSubjects(
  tx: SQL,
  spaceId: string,
  projectId: string,
  from: string,
  to: string,
): Promise<void> {
  const projectScopes = tx.array(
    Object.entries(DOC_SCOPE_SUBJECT_KIND)
      .filter(([, kind]) => kind === 'project')
      .map(([scope]) => scope),
    'text',
  )
  await tx`
    UPDATE doc SET subject=${to}, updated_at=now()
    WHERE space_id=${spaceId}::uuid AND subject=${from}
      AND (project_id=${projectId}::uuid OR (project_id IS NULL AND scope=ANY(${projectScopes})))
  `
  await tx`
    UPDATE doc_revision SET subject=${to}
    WHERE space_id=${spaceId}::uuid AND subject=${from}
      AND (project_id=${projectId}::uuid OR (project_id IS NULL AND scope=ANY(${projectScopes})))
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
      WHERE project_id=${input.projectId}::uuid
         OR (project_id IS NULL AND space_id=${input.spaceId}::uuid AND project_name=${input.from})`
  }
  await tx`
    UPDATE hub_task SET project=${input.to}
    WHERE project_id=${input.projectId}::uuid
       OR (project_id IS NULL AND space_id=${input.spaceId}::uuid AND project=${input.from})
  `
  await tx`
    UPDATE hub_note SET project=${input.to}
    WHERE project_id=${input.projectId}::uuid
       OR (project_id IS NULL AND space_id=${input.spaceId}::uuid AND project=${input.from})
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
    id?: string
  },
): Promise<string> {
  const id = input.id ?? newRecordId()
  const columns = input.columns
  const rows = await tx`
    INSERT INTO project (
      id, space_id, name, key_prefixes, checkout_path, stack, canon, managed_context,
      landing_branch, production_branch, gate, focused_tests, require_clean_main, color,
      color_dark, env_prefix, mcp_server, worker_mcp_servers, secret_paths,
      mcp_probe_tool, mcp_reader_tools, docs, reference, signals, review, test_substance, mechanical_checks, release, states, tracker, worktree, retired_at, created_at
    ) VALUES (
      ${id}::uuid, ${input.spaceId}::uuid, ${input.name}, ${tx.array(columns.keyPrefixes, 'text')},
      ${input.path}, ${input.stack}, ${input.canon}, ${columns.managedContext},
      ${columns.landingBranch}, ${columns.productionBranch}, ${columns.gate},
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
    ON CONFLICT (space_id, name) DO UPDATE SET
      key_prefixes = EXCLUDED.key_prefixes,
      checkout_path = EXCLUDED.checkout_path,
      stack = EXCLUDED.stack,
      canon = EXCLUDED.canon,
      managed_context = EXCLUDED.managed_context,
      landing_branch = EXCLUDED.landing_branch,
      production_branch = EXCLUDED.production_branch,
      gate = EXCLUDED.gate,
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
    const rows =
      await tx`SELECT p.id, p.space_id, s.name AS space_name, p.name, p.key_prefixes, p.stack,
        p.managed_context, p.landing_branch, p.color, p.color_dark, p.retired_at
        FROM project p JOIN space s ON s.id=p.space_id ORDER BY s.name,p.name`
    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      spaceId: String(row.space_id),
      spaceName: String(row.space_name),
      name: String(row.name),
      keyPrefixes: row.key_prefixes as string[],
      stack: row.stack == null ? null : String(row.stack),
      managedContext: row.managed_context === true,
      landingBranch: row.landing_branch == null ? null : String(row.landing_branch),
      color: row.color == null ? null : String(row.color),
      colorDark: row.color_dark == null ? null : String(row.color_dark),
      retiredAt: row.retired_at == null ? null : new Date(String(row.retired_at)).toISOString(),
    }))
  })
}

export async function upsertRecordProject(
  input: Tenant & RecordProjectUpsertInput,
): Promise<{ id: string; name: string }> {
  return tenant(input, async (tx) => {
    const currentName = input.previousName ?? input.name
    const nextName = input.name
    const currentRows = await tx`
      SELECT id, name, retired_at, checkout_path FROM project
      WHERE space_id=${input.spaceId}::uuid AND name=${currentName}
    `
    const nextRows =
      currentName === nextName
        ? currentRows
        : await tx`
          SELECT id, name, retired_at, checkout_path FROM project
          WHERE space_id=${input.spaceId}::uuid AND name=${nextName}
        `
    const plan = decideHostedProjectWrite({
      currentName,
      nextName,
      path: input.path,
      current: namedRow(currentRows[0] as Record<string, unknown> | undefined),
      next: namedRow(nextRows[0] as Record<string, unknown> | undefined),
    })
    if (plan.kind === 'refuse') throw new RecordProjectError(plan.message, 409)
    let columns: HostedProjectColumns
    try {
      columns = hostedProjectColumns(input.settings, nextName)
    } catch (error) {
      throw new RecordProjectError(error instanceof Error ? error.message : String(error), 400)
    }
    if (plan.kind === 'rename') {
      await tx`UPDATE project SET name=${plan.to} WHERE id=${plan.id}::uuid`
      await renameHostedHubProjectNames(tx, {
        spaceId: input.spaceId,
        projectId: plan.id,
        from: plan.from,
        to: plan.to,
      })
      await renameHostedDocSubjects(tx, input.spaceId, plan.id, currentName, nextName)
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
}

export async function retireRecordProject(
  input: Tenant & { name: string },
): Promise<{ name: string }> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      UPDATE project SET retired_at = now()
      WHERE space_id=${input.spaceId}::uuid AND name=${input.name}
      RETURNING name
    `
    if (!rows.length) throw new RecordProjectError(`hosted project "${input.name}" not found`, 404)
    return { name: String(rows[0]!.name) }
  })
}
