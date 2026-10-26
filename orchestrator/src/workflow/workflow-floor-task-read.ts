// concern: workflows
/** One tracker task read as the floor verifier consumes it. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isTrackerCommentId } from '../../../shared/trackers.ts'

export type HubTaskRead = {
  recordId?: string
  key: string
  status: string | null
  statusCategory: string | null
  commentIds: Array<string | number>
  commentsVerifiable?: boolean
}

type HubTaskReadJson = {
  task?: {
    key?: string
    record_id?: string
    status?: string | null
    status_category?: string | null
  }
  comments?: Array<{ id?: number | string }>
  /** The tracker read's own comment ids, present on a fresh tracker read. */
  tracker_comment_ids?: Array<number | string>
  tracker_comments_verifiable?: boolean
}

/** The ids a task read carries, dropping the entries that name no comment. */
function carriedCommentIds(ids: Array<number | string | undefined>): string[] {
  return ids.filter(isTrackerCommentId).map(String)
}

/**
 * One task read as the verifier consumes it. A fresh tracker read reports the
 * tracker's own comment ids, so those decide; a read without them is verified
 * against the comment ids it carries.
 */
export function hubTaskReadFromJson(key: string, parsed: unknown): HubTaskRead {
  const read = (parsed ?? {}) as HubTaskReadJson
  if (!read.task?.key || !read.task.record_id)
    throw new Error(`--task ${key} was not a ${PLATFORM_SLUG} task show record`)
  return {
    recordId: read.task.record_id,
    key: read.task.key,
    status: read.task.status ?? null,
    statusCategory: read.task.status_category ?? null,
    commentIds: carriedCommentIds(
      read.tracker_comment_ids ?? (read.comments ?? []).map((comment) => comment.id),
    ),
    commentsVerifiable: read.tracker_comments_verifiable !== false,
  }
}
