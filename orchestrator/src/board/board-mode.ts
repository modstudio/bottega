// concern: board-mode-adapter
/** Gathers install facts for the shared board-mode decision. */
import type { Database } from 'bun:sqlite'
import {
  type BoardLocality,
  decideBoardIdMode,
  decideBoardMode,
} from '../../../shared/board-mode.ts'
import { recordApiConfigured } from '../../../shared/record-api-url.ts'
import { db } from '../database/db.ts'

export const BOARD_HOSTED_ADOPTED_KEY = 'board_hosted_adopted'
export type { BoardLocality } from '../../../shared/board-mode.ts'

export function boardHasAdoptedHosted(database: Database = db()): boolean {
  return (
    database
      .query<{ value: string }, [string]>('SELECT value FROM schema_meta WHERE key=?')
      .get(BOARD_HOSTED_ADOPTED_KEY)?.value === '1'
  )
}

export function boardMode(
  locality: BoardLocality,
  environment: Record<string, string | undefined> = process.env,
  database: Database = db(),
): 'local' | 'hosted' {
  const decision = boardModeDecision(locality, environment, database)
  if (decision.mode === 'refused') throw new Error(decision.reason)
  return decision.mode
}

export function boardModeDecision(
  locality: BoardLocality,
  environment: Record<string, string | undefined> = process.env,
  database: Database = db(),
) {
  return decideBoardMode({
    adopted: boardHasAdoptedHosted(database),
    hostedConfigured: () => recordApiConfigured(environment),
    locality,
  })
}

export function boardModeForId(
  id: string,
  noun?: string,
  environment: Record<string, string | undefined> = process.env,
  database: Database = db(),
): 'local' | 'hosted' {
  const decision = decideBoardIdMode({
    id,
    noun,
    adopted: boardHasAdoptedHosted(database),
    hostedConfigured: () => recordApiConfigured(environment),
  })
  if (decision.mode === 'refused') throw new Error(decision.reason)
  return decision.mode
}
