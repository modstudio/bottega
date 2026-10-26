import { DB_PATH, db } from './db.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { formatProjectWriteModes } from './hosted-write-mode.ts'
import { readInstallBinding } from './install-binding.ts'
import { canonicalSchemaHash, expectedSchemaHash, schemaVersionLabel } from './migrations.ts'
import { hostedOutboxDoctorLines } from './outbox.ts'
import { projects } from './projects.ts'
import { formatServiceRevisionDoctor } from './service-revision.ts'
import { formatTaskIdentityDoctor, taskIdentityDoctor } from './task-identity.ts'

function intervalTaskLinkDoctor(): string {
  const count = db()
    .query<{ count: number }, []>(
      `SELECT COUNT(*) count FROM interval WHERE task_key IS NOT NULL AND task_record_id IS NULL`,
    )
    .get()!.count
  return `interval links ${count} task-key interval${count === 1 ? '' : 's'} unlinked`
}

export async function hubDoctorLines(): Promise<string[]> {
  const outbox = await hostedOutboxDoctorLines()
  return [
    `database       ${DB_PATH}`,
    `schema hash    ${canonicalSchemaHash(db()) === expectedSchemaHash() ? 'match' : 'DRIFT'}`,
    `schema version ${schemaVersionLabel(db())}`,
    ...formatTaskIdentityDoctor(taskIdentityDoctor()),
    intervalTaskLinkDoctor(),
    ...formatServiceRevisionDoctor(),
    ...formatProjectWriteModes(projects(), readInstallBinding(), resolveHostedUrl()),
    ...outbox,
  ]
}
