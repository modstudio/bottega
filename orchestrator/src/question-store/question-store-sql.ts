// concern: question-store-sql
/** Pure SQL fragments shared by the question adapters and run callers. */

export function questionOpenSql(alias: string): string {
  return `${alias}.answered_at IS NULL AND ${alias}.closed_at IS NULL`
}

export function questionTaskHolderSql(questionAlias: string, runAlias: string): string {
  return (
    `COALESCE(${runAlias}.launch_key,${questionAlias}.workflow_key,` +
    `(SELECT root.launch_key FROM run root WHERE root.record_id=${runAlias}.parent_run_record_id))`
  )
}
