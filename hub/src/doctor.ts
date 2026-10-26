import { DB_PATH, db } from './db.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { formatProjectWriteModes } from './hosted-write-mode.ts'
import { readInstallBinding } from './install-binding.ts'
import { canonicalSchemaHash, expectedSchemaHash, schemaVersionLabel } from './migrations.ts'
import { hostedOutboxDoctorLines } from './outbox.ts'
import { projects } from './projects.ts'
import { formatServiceRevisionDoctor } from './service-revision.ts'
import { formatTaskIdentityDoctor, taskIdentityDoctor } from './task-identity.ts'

export const INTERVAL_UNLINKED_KEY_LIMIT = 10

function unlinkedTaskKeyLine(
  label: string,
  keys: readonly { task_key: string; count: number }[],
): string {
  const shown = keys.slice(0, INTERVAL_UNLINKED_KEY_LIMIT)
  const remaining = Math.max(0, keys.length - shown.length)
  return `${label} unlinked task keys ${shown.length ? shown.map((row) => `${row.task_key} (${row.count})`).join(', ') : 'none'}${remaining ? `, and ${remaining} more` : ''}`
}

function intervalTaskLinkDoctor(): string[] {
  const keys = db()
    .query<{ task_key: string; count: number }, []>(
      `SELECT task_key,COUNT(*) count FROM interval
       WHERE task_key IS NOT NULL AND task_record_id IS NULL
       GROUP BY task_key ORDER BY count DESC,task_key`,
    )
    .all()
  const shown = keys.slice(0, INTERVAL_UNLINKED_KEY_LIMIT)
  const remaining = Math.max(0, keys.length - shown.length)
  const neither = db()
    .query<{ count: number }, []>(
      `SELECT COUNT(*) count FROM interval
       WHERE task_record_id IS NULL AND project_record_id IS NULL`,
    )
    .get()!.count
  return [
    `interval links unlinked task keys ${shown.length ? shown.map((row) => `${row.task_key} (${row.count})`).join(', ') : 'none'}${remaining ? `, and ${remaining} more` : ''}`,
    `interval links ${neither} interval${neither === 1 ? '' : 's'} with neither task nor project`,
  ]
}

function questionCommitTaskLinkDoctor(): string[] {
  const questionTaskKeys = db()
    .query<{ task_key: string; count: number }, []>(
      `SELECT task_key,COUNT(*) count FROM question
       WHERE task_key IS NOT NULL AND task_record_id IS NULL
       GROUP BY task_key ORDER BY count DESC,task_key`,
    )
    .all()
  const questionWorkflowKeys = db()
    .query<{ task_key: string; count: number }, []>(
      `SELECT workflow_key task_key,COUNT(*) count FROM question
       WHERE workflow_key IS NOT NULL AND workflow_task_record_id IS NULL
       GROUP BY workflow_key ORDER BY count DESC,workflow_key`,
    )
    .all()
  const commitTaskKeys = db()
    .query<{ task_key: string; count: number }, []>(
      `SELECT task_key,COUNT(*) count FROM commit_key
       WHERE task_key IS NOT NULL AND task_record_id IS NULL
       GROUP BY task_key ORDER BY count DESC,task_key`,
    )
    .all()
  return [
    unlinkedTaskKeyLine('question.task_key links', questionTaskKeys),
    unlinkedTaskKeyLine('question.workflow_key links', questionWorkflowKeys),
    unlinkedTaskKeyLine('commit_key.task_key links', commitTaskKeys),
  ]
}

export async function hubDoctorLines(): Promise<string[]> {
  const outbox = await hostedOutboxDoctorLines()
  return [
    `database       ${DB_PATH}`,
    `schema hash    ${canonicalSchemaHash(db()) === expectedSchemaHash() ? 'match' : 'DRIFT'}`,
    `schema version ${schemaVersionLabel(db())}`,
    ...formatTaskIdentityDoctor(taskIdentityDoctor()),
    ...intervalTaskLinkDoctor(),
    ...questionCommitTaskLinkDoctor(),
    ...formatServiceRevisionDoctor(),
    ...formatProjectWriteModes(projects(), readInstallBinding(), resolveHostedUrl()),
    ...outbox,
  ]
}
