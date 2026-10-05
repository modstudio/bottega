import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { BoardSessionContext } from './board-routing.ts'

const BOARD_CONTEXT_RUN_WINDOW_MS = 24 * 60 * 60 * 1000

type ContextRun = { launch_key: string | null; changed_paths: string | null }

export function boardContext(
  session: string,
  clock: number,
  database: Database = db(),
): BoardSessionContext {
  const presence = database
    .query('SELECT current_task_key FROM presence WHERE session_id=?')
    .get(session) as { current_task_key: string | null } | null
  const runs = database
    .query(
      `SELECT launch_key,changed_paths FROM run
       WHERE session_id=? AND started_at>=?`,
    )
    .all(session, new Date(clock - BOARD_CONTEXT_RUN_WINDOW_MS).toISOString()) as ContextRun[]
  const taskKeys = new Set<string>()
  if (presence?.current_task_key) taskKeys.add(presence.current_task_key)
  const changedPaths = new Set<string>()
  for (const run of runs) {
    if (run.launch_key) taskKeys.add(run.launch_key)
    if (!run.changed_paths) continue
    const paths: unknown = JSON.parse(run.changed_paths)
    if (Array.isArray(paths))
      for (const path of paths) if (typeof path === 'string') changedPaths.add(path)
  }
  return { taskKeys, changedPaths, topics: new Set() }
}
