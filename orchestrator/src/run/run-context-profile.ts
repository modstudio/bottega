// concern: durable run context profile
/** Owns the harness-neutral run context profile shape and its local row write. */

import type { Database } from 'bun:sqlite'

export type GooseContextProfile = {
  systemChars: number | null
  toolCount: number | null
  toolSchemaChars: number | null
  compactions: number | null
  cacheReadTokens: number | null
}

export function writeRunContextProfile(
  database: Database,
  runId: string,
  profile: GooseContextProfile | null | undefined,
): void {
  database
    .query(
      `UPDATE run SET context_system_chars=?, context_tool_count=?, context_tool_schema_chars=?,
                      context_compactions=?, context_cache_read_tokens=? WHERE record_id=?`,
    )
    .run(
      profile?.systemChars ?? null,
      profile?.toolCount ?? null,
      profile?.toolSchemaChars ?? null,
      profile?.compactions ?? null,
      profile?.cacheReadTokens ?? null,
      runId,
    )
}
