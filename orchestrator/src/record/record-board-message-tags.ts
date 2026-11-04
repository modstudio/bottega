// concern: record-board-message-tags
/** Reads and inserts hosted board message tags. */

import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record-id.ts'
import type { BoardTag } from '../board/board-tags.ts'

export function hostedBoardTags(rows: Record<string, unknown>[]): BoardTag[] {
  return rows.map((row) => ({
    kind: String(row.kind) as BoardTag['kind'],
    value: String(row.value),
    origin: String(row.origin) as BoardTag['origin'],
  }))
}

export async function readBoardMessageTags(tx: SQL, id: string): Promise<BoardTag[]> {
  const rows = await tx`
    SELECT kind, value, origin FROM board_message_tag
    WHERE message_id=${id}::uuid ORDER BY kind, value, origin
  `
  return hostedBoardTags(rows as Record<string, unknown>[])
}

export async function insertBoardMessageTags(
  tx: SQL,
  messageId: string,
  tags: BoardTag[],
): Promise<void> {
  for (const tag of tags) {
    await tx`
      INSERT INTO board_message_tag (id, message_id, kind, value, origin)
      VALUES (${newRecordId()}::uuid, ${messageId}::uuid, ${tag.kind}, ${tag.value}, ${tag.origin})
      ON CONFLICT DO NOTHING
    `
  }
}
