// concern: harness run handoff
/** Builds the one synchronous handoff shape printed by every harness launch path. */

import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { Database } from 'bun:sqlite'
import { HARNESS_EXECUTOR } from './run-executor.ts'

export type HarnessHandoff = {
  run: number
  record_id: string
  prompt_path: string
  working_directory: string
  finish_command: string
}

export function harnessHandoff(database: Database, id: string): HarnessHandoff | null {
  const row = database
    .query('SELECT number,record_id,prompt_path,cwd,executor FROM run WHERE record_id=?')
    .get(id) as {
    number: number
    record_id: string
    prompt_path: string | null
    cwd: string | null
    executor: string
  } | null
  if (!row || row.executor !== HARNESS_EXECUTOR) return null
  if (!row.prompt_path || !row.cwd) throw new Error(`harness run ${id} has no prompt path or cwd`)
  return {
    run: row.number,
    record_id: row.record_id,
    prompt_path: join(dirname(row.prompt_path), 'bound-prompt.txt'),
    working_directory: row.cwd,
    finish_command: `${PLATFORM_SLUG} run finish ${row.record_id}`,
  }
}

export function printHarnessHandoff(handoff: HarnessHandoff, json = false): void {
  if (json) {
    console.log(JSON.stringify(handoff))
    return
  }
  console.log(`run: ${handoff.run}`)
  console.log(`record_id: ${handoff.record_id}`)
  console.log(`prompt: ${handoff.prompt_path}`)
  console.log(`working_directory: ${handoff.working_directory}`)
  console.log(`finish: ${handoff.finish_command}`)
}
