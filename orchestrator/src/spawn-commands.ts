// concern: health
/** Owns spawn-gate reporting. Must not know CLI grammar. */
import { db } from './db.ts'

export function spawnsCommand(limit: number, presentation: { log(value: string): void }): void {
  const rows = db().query('SELECT decision, why, COUNT(*) n FROM spawn GROUP BY decision, why ORDER BY n DESC').all() as { decision: string; why: string; n: number }[]
  if (!rows.length) { presentation.log('no spawns recorded yet'); return }
  const total = rows.reduce((sum, row) => sum + row.n, 0)
  presentation.log(`\n  ${total} subagent spawn(s) seen by the gate\n`)
  for (const row of rows) presentation.log(`  ${row.decision.padEnd(8)} ${row.why.padEnd(14)} ${String(row.n).padStart(4)}  ${((row.n / total) * 100).toFixed(0)}%`)
  const recent = db().query('SELECT at, decision, why, subagent_type, description FROM spawn ORDER BY id DESC LIMIT ?').all(limit) as Record<string, string>[]
  presentation.log('\n  when                 decision  why             what')
  for (const row of recent) presentation.log(`  ${String(row.at).replace('T', ' ').slice(0, 19)}  ${String(row.decision).padEnd(8)}  ${String(row.why).padEnd(14)}  ${String(row.description ?? '').slice(0, 46)}`)
  presentation.log('\n  A denial is work an external agent could have done. A rising share of\n  "declared-web" that is not really web work is the thing to watch for.')
}
