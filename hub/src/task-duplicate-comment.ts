import { sendHostedChanges } from './hosted-change-sender.ts'
import { HOSTED_COMMENT_TABLE, type PushedComment } from './push-contract.ts'
import type { Attribution } from './task-attribution.ts'
import { pushedComment } from './task-hosted-record.ts'
import type { TaskRow } from './task-row.ts'
import {
  hostedTaskChangeSendOptions,
  type HostedTaskWriteOptions,
} from './task-write-destination.ts'

export async function sendDuplicateReasonComment(
  task: TaskRow,
  reason: string | undefined,
  at: string,
  attribution: Attribution,
  hosted?: HostedTaskWriteOptions,
): Promise<PushedComment | null> {
  if (!reason) return null
  const comment = pushedComment(task, reason, at, attribution)
  await sendHostedChanges(
    'the record',
    [
      [
        {
          table: HOSTED_COMMENT_TABLE,
          id: comment.id,
          op: 'upsert',
          row: comment,
          expected_revision: 0,
        },
      ],
    ],
    hostedTaskChangeSendOptions(task.key, task.project, hosted),
  )
  return comment
}
