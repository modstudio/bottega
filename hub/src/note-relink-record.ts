// concern: note relink record
/** Sends a hosted relink trail, then applies its accepted rows to the local mirror. */

import { db, writeTransaction } from './db.ts'
import { sendHostedChanges } from './hosted-change-sender.ts'
import type { NoteClientOptions } from './note-client.ts'
import { noteChangeSendOptions, pushedNote } from './note-hosted-record.ts'
import type { NoteRow } from './note-row.ts'
import { HOSTED_NOTE_TABLE } from './push-contract.ts'
import { recordNoteRelinkCommentsInTransaction } from './task.ts'

export async function relinkHostedNote(
  current: NoteRow,
  target: string,
  reason: string,
  at: string,
  options?: NoteClientOptions,
): Promise<NoteRow> {
  const prepared = recordNoteRelinkCommentsInTransaction(
    db(),
    {
      project: current.project,
      noteLabel: current.label,
      previousTask: current.promoted_task!,
      targetTask: target,
      reason,
      at,
      queue: false,
    },
    false,
  )
  const updated: NoteRow = {
    ...current,
    promoted_task: target,
    promoted_task_record_id: prepared.targetTaskRecordId,
    last_seen_at: at,
  }
  await sendHostedChanges(
    `note ${current.label}`,
    [
      [
        ...prepared.comments.map(
          (comment) =>
            ({
              table: 'hub_task_comment',
              id: comment.id,
              op: 'upsert',
              row: comment,
              expected_revision: 0,
            }) as const,
        ),
        {
          table: HOSTED_NOTE_TABLE,
          id: current.record_id,
          op: 'upsert',
          row: pushedNote(updated, at),
          fields: ['promoted_task', 'promoted_task_id', 'last_seen_at'],
          expected_revision: current.revision,
        },
      ],
    ],
    await noteChangeSendOptions(current.project, options),
  )
  writeTransaction((conn) => {
    recordNoteRelinkCommentsInTransaction(conn, prepared)
    conn
      .query(
        `UPDATE note SET promoted_task=?,promoted_task_record_id=?,last_seen_at=? WHERE record_id=?`,
      )
      .run(target, prepared.targetTaskRecordId, at, current.record_id)
  })
  return updated
}
