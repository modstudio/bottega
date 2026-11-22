import { sendHostedChanges } from './hosted-change-sender.ts'
import { HOSTED_COMMENT_TABLE, type PushedComment } from './push-contract.ts'
import {
  type HostedTaskWriteOptions,
  hostedTaskChangeSendOptions,
} from './task-write-destination.ts'

export async function sendTaskCommentRecord(
  comment: PushedComment,
  options: {
    hosted?: HostedTaskWriteOptions
    fields?: string[]
    expected_revision?: number
  } = {},
): Promise<void> {
  await sendHostedChanges(
    'the record',
    [
      [
        {
          table: HOSTED_COMMENT_TABLE,
          id: comment.id,
          op: 'upsert',
          row: comment,
          fields: options.fields,
          expected_revision: options.expected_revision ?? 0,
        },
      ],
    ],
    hostedTaskChangeSendOptions(comment.task_key, comment.project_name, options.hosted),
  )
}
