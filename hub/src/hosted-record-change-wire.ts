import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import type { HostedSend } from './hosted-reports.ts'
import type {
  HostedComment,
  HostedDocument,
  HostedStatusEvent,
  HostedTask,
} from './hosted-tasks.ts'

export type HostedChangeRow =
  | HostedTask
  | HostedComment
  | HostedDocument
  | HostedStatusEvent
  | HostedNote
  | HostedAcknowledgement
  | HostedSend

export type HostedRecordChange = {
  table: string
  id: string
  space: string
  op: 'upsert' | 'delete'
  row?: HostedChangeRow
}

export type HostedRecordChangePage = {
  changes: HostedRecordChange[]
  cursor: string
  lag: number
  more: boolean
}

export type HostedRecordChangeResult =
  | HostedRecordChangePage
  | { reset: { cursor: string; tables: string[] } }
