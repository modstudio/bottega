const BACKFILL_UNCLOSED = 'migration backfill blocks must be closed by -- /BACKFILL'

export type MigrationSourceParts = {
  ddl: string
  backfill: string
  backfillBlocks: { sql: string; offset: number }[]
}

/** DDL for hashing and one-time apply; backfill blocks are excluded so they can evolve. */
export function splitMigrationSource(source: string): MigrationSourceParts {
  const opens = source.match(/^[ \t]*--[ \t]*BACKFILL[ \t]*$/gm) ?? []
  const closes = source.match(/^[ \t]*--[ \t]*\/BACKFILL[ \t]*$/gm) ?? []
  if (opens.length !== closes.length) {
    throw new Error(
      `refusing to load a migration whose backfill block is not closed\n` +
        `invariant: ${BACKFILL_UNCLOSED}`,
    )
  }
  const backfillBlocks: MigrationSourceParts['backfillBlocks'] = []
  const ddl = source.replace(
    /^[ \t]*--[ \t]*BACKFILL[ \t]*\r?\n([\s\S]*?)^[ \t]*--[ \t]*\/BACKFILL[ \t]*\r?\n?/gm,
    (match, body: string, offset: number) => {
      backfillBlocks.push({ sql: body, offset: offset + match.indexOf(body) })
      return ''
    },
  )
  return { ddl, backfill: backfillBlocks.map(({ sql }) => sql).join('\n'), backfillBlocks }
}
