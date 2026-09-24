import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import type { MirrorAdoption } from './hosted-tasks.ts'

const COLLISION_COUNT_KEY = 'task.adoption_collisions'

export function persistTaskAdoptions(
  adoptions: readonly Extract<MirrorAdoption, { table: 'task' }>[],
  conn: Database = db(),
): number {
  if (!adoptions.length) return 0
  return writeTransaction((transaction) => persistTaskAdoptionsOn(transaction, adoptions), conn)
}

export function persistTaskAdoptionsOn(
  transaction: Database,
  adoptions: readonly Extract<MirrorAdoption, { table: 'task' }>[],
): number {
  let collisions = 0
  const holder = transaction.query<{ project: string; key: string }, [string]>(
    `SELECT project,key FROM task WHERE record_id=?`,
  )
  const update = transaction.query(`UPDATE task SET record_id=? WHERE project=? AND key=?`)
  for (const adoption of adoptions) {
    const existing = holder.get(adoption.id)
    if (existing && (existing.project !== adoption.project || existing.key !== adoption.key)) {
      collisions++
      console.error(
        `hub: task adoption skipped: hosted id ${adoption.id} for ${adoption.project} ${adoption.key} ` +
          `already belongs locally to ${existing.project} ${existing.key}`,
      )
      continue
    }
    update.run(adoption.id, adoption.project, adoption.key)
  }
  if (collisions)
    transaction
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?)
           ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+excluded.value`,
      )
      .run(COLLISION_COUNT_KEY, collisions)
  return collisions
}

export function taskAdoptionCollisionCount(conn: Database = db()): number {
  const value = conn
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
    .get(COLLISION_COUNT_KEY)?.value
  return Number(value ?? 0)
}
