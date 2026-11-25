import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { boardMode } from './board-mode.ts'

export function requireLocalBoardRead(
  environment: Record<string, string | undefined> = process.env,
  database: Database = db(),
): void {
  if (boardMode('shared', environment, database) === 'local') return
  throw new Error(
    'requireLocalBoardRead stopped a local board read; a hosted install reads the board through the hosted reader',
  )
}

export function requireLocalBoardWrite(
  verb: 'claim release' | 'claim renew',
  environment: Record<string, string | undefined> = process.env,
  database: Database = db(),
): void {
  if (boardMode('shared', environment, database) === 'local') return
  throw new Error(
    `a hosted install cannot change a local board claim; use ${PLATFORM_SLUG} board ${verb} with the hosted claim UUID`,
  )
}
