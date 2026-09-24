// concern: record-projects
/** Owns the presentation-safe tenant project projection. */
import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'

export type RecordProject = {
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

export async function listRecordProjects(
  input: { url: string } & TenantPrincipal,
): Promise<RecordProject[]> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      const rows =
        await tx`SELECT p.space_id, s.name AS space_name, p.name, p.key_prefixes, p.stack,
          p.managed_context, p.landing_branch, p.color, p.color_dark, p.retired_at
          FROM project p JOIN space s ON s.id=p.space_id ORDER BY s.name,p.name`
      return rows.map((row: Record<string, unknown>) => ({
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
  } finally {
    await client.close()
  }
}
