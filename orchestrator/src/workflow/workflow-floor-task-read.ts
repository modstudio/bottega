// concern: workflows
/** One tracker task read as the floor verifier consumes it. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { withholdSecretShapedDetail } from '../../../shared/secret-shaped.ts'
import { namesMissingTask } from '../../../shared/task-missing.ts'
import { isTrackerCommentId } from '../../../shared/trackers.ts'
import { taskReader } from './task-read-port.ts'
import { readFreshHubTaskThroughCli } from './workflow-task-reference.ts'

export type HubTaskRead = {
  recordId?: string
  key: string
  updatedAt: string | null
  status: string | null
  statusCategory: string | null
  commentIds: Array<string | number>
  commentWrittenAt?: Record<string, string>
  commentsVerifiable?: boolean
}

export async function readHubTaskDocument(
  value: string,
  scope: { project: string; recordId?: string },
): Promise<{ id: string; label: string; task_record_id: string; updated_at: string } | null> {
  try {
    return await taskReader().document(value, scope)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const key = value.split('/', 1)[0]!
    if (namesMissingTask(detail, key) || namesMissingTaskDocument(detail, value)) return null
    throw error
  }
}

export function namesMissingTaskDocument(text: string, value: string): boolean {
  const expected = `no task document ${value}`
  return text.split('\n').some((line) => line.trim() === expected)
}

type HubTaskReadJson = {
  task?: {
    key?: string
    updated_at?: string | null
    record_id?: string
    status?: string | null
    status_category?: string | null
  }
  comments?: Array<{ id?: number | string; created_at?: string; updated_at?: string | null }>
  /** The tracker read's own comment ids, present on a fresh tracker read. */
  tracker_comment_ids?: Array<number | string>
  tracker_comments_verifiable?: boolean
  tracker_updated_at?: string | null
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
    updatedAt:
      'tracker_updated_at' in read
        ? (read.tracker_updated_at ?? null)
        : (read.task.updated_at ?? null),
    status: read.task.status ?? null,
    statusCategory: read.task.status_category ?? null,
    commentIds: carriedCommentIds(
      read.tracker_comment_ids ?? (read.comments ?? []).map((comment) => comment.id),
    ),
    commentWrittenAt: Object.fromEntries(
      (read.comments ?? []).flatMap((comment) => {
        if (!isTrackerCommentId(comment.id) || !comment.created_at) return []
        return [[String(comment.id), comment.updated_at ?? comment.created_at]]
      }),
    ),
    commentsVerifiable: read.tracker_comments_verifiable !== false,
  }
}

export function hubTaskReadRefusal(
  key: string,
  status: number | null,
  stderr: string,
  stdout: string,
): string {
  const rawDetail = stderr.trim() || stdout.trim() || `${PLATFORM_SLUG} exited ${status}`
  const detail = withholdSecretShapedDetail(rawDetail)
  const attempted = `${PLATFORM_SLUG} task show ${key} --json --fresh`
  if (
    namesMissingTask(rawDetail, key) ||
    rawDetail
      .split('\n')
      .some((line) => line.trim().includes(`task ${key} was not found in project`))
  )
    return `--task ${key} was not found in the project's tracker; ${attempted} attempted the registered tracker read: ${detail}`
  return `--task ${key} could not be read through the project's tracker by ${attempted}: ${detail}`
}

export function readHubTask(key: string, cwd = process.cwd()): HubTaskRead {
  try {
    return hubTaskReadFromJson(key, JSON.parse(readFreshHubTaskThroughCli(key, { cwd })))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(hubTaskReadRefusal(key, 1, detail, ''))
  }
}
