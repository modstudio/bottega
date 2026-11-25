import type { Database } from 'bun:sqlite'
import type { BoardLocality } from '../../../shared/board-mode.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { boardMode } from './board-mode.ts'

export function requireLocalBoardRead(
  environment: Record<string, string | undefined> = process.env,
  database: Database = db(),
  locality: BoardLocality = 'shared',
): void {
  if (boardMode(locality, environment, database) === 'local') return
  throw new Error(
    'requireLocalBoardRead stopped a local board read; a hosted install reads the board through the hosted reader',
  )
}

export function requireLocalBoardWrite(
  verb:
    | 'claim release'
    | 'claim renew'
    | 'claim take'
    | 'claim maintenance'
    | 'notice post'
    | 'notice delivery'
    | 'notice acknowledge'
    | 'notice withdraw'
    | 'notice reap'
    | 'reply post'
    | 'answer accept',
  environment: Record<string, string | undefined> = process.env,
  database: Database = db(),
  locality: BoardLocality = 'shared',
): void {
  if (boardMode(locality, environment, database) === 'local') return
  const commands: Partial<Record<typeof verb, string>> = {
    'claim release': `${PLATFORM_SLUG} board claim release with the hosted claim UUID`,
    'claim renew': `${PLATFORM_SLUG} board claim renew with the hosted claim UUID`,
    'claim take': `${PLATFORM_SLUG} board claim take`,
    'notice post': `${PLATFORM_SLUG} board post`,
    'notice acknowledge': `${PLATFORM_SLUG} board ack with the hosted message UUID`,
    'notice withdraw': `${PLATFORM_SLUG} board withdraw with the hosted message UUID`,
    'reply post': `${PLATFORM_SLUG} board reply with the hosted message UUID`,
    'answer accept': `${PLATFORM_SLUG} board accept with the hosted message UUID`,
  }
  const remedy = commands[verb]
    ? `use ${commands[verb]}`
    : 'a hosted install writes the board through the hosted record'
  throw new Error(`requireLocalBoardWrite stopped local board ${verb}; ${remedy}`)
}
