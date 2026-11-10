// concern: hosted-board-read-cache
/** Compares incoming hosted messages with the locally cached revision. */

import type { Database } from 'bun:sqlite'

export function hostedBoardMessageIsStale(
  database: Database,
  id: string,
  incoming: string,
): boolean {
  const cached = (
    database.query('SELECT revision FROM hosted_board_message_cache WHERE id=?').get(id) as {
      revision: string
    } | null
  )?.revision
  return cached !== undefined && BigInt(incoming) < BigInt(cached)
}
