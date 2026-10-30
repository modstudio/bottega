export const RECORD_REHEARSAL_STATUS_CONTEXT = 'record-rehearsal'

type RecordRehearsalDescription = {
  hash: string
  pending: number
  restoreMs: number
  migrateMs: number
  dump: string
}

function format(value: RecordRehearsalDescription): string {
  return `migration-set ${value.hash}; pending ${value.pending}; restore ${value.restoreMs}; migrate ${value.migrateMs}; dump ${value.dump}`
}

function parse(description: string): RecordRehearsalDescription | null {
  const match =
    /^migration-set ([0-9a-f]{64}); pending (\d+); restore (\d+); migrate (\d+); dump (.+)$/.exec(
      description,
    )
  if (!match) return null
  return {
    hash: match[1]!,
    pending: Number(match[2]),
    restoreMs: Number(match[3]),
    migrateMs: Number(match[4]),
    dump: match[5]!,
  }
}

export const recordRehearsalDescription = { format, parse }
