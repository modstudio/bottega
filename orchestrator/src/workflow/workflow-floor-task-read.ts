// concern: workflows
/** One tracker task read as the floor verifier consumes it. */

import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { withholdSecretShapedDetail } from '../../../shared/secret-shaped.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { namesMissingTask } from '../../../shared/task-missing.ts'
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
  const [hub, ...prefix] = bottegaEntryArgv(PLATFORM_SLUG)
  const result = startBoundedSync([hub!, ...prefix, 'task', 'show', key, '--json', '--fresh'], {
    budget: 'self-cli',
    cwd,
    env: process.env,
  })
  if (result.exitCode !== 0)
    throw new Error(hubTaskReadRefusal(key, result.exitCode, result.stderr, result.stdout))
  return hubTaskReadFromJson(key, JSON.parse(result.stdout))
}
