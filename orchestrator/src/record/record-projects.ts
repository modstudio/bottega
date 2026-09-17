// concern: record-projects
/** Owns the presentation-safe tenant project projection. */
import { SQL } from 'bun'

export type RecordProject = {
  name: string
  keyPrefixes: string[]
  stack: string | null
  landingBranch: string | null
  color: string | null
  colorDark: string | null
  retiredAt: string | null
}

export async function listRecordProjects(input: {
  url: string
  userId: string
  spaceId: string
}): Promise<RecordProject[]> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
      await tx`SELECT set_config('app.space_id', ${input.spaceId}, true)`
      const rows =
        await tx`SELECT name, key_prefixes, stack, landing_branch, color, color_dark, retired_at FROM project ORDER BY name`
      return rows.map((row: Record<string, unknown>) => ({
        name: String(row.name),
        keyPrefixes: row.key_prefixes as string[],
        stack: row.stack == null ? null : String(row.stack),
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
