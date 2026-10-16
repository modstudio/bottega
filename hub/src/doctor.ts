import { DB_PATH, db } from './db.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { formatProjectWriteModes } from './hosted-write-mode.ts'
import { readInstallBinding } from './install-binding.ts'
import { canonicalSchemaHash, expectedSchemaHash, schemaVersionLabel } from './migrations.ts'
import { hostedOutboxDoctorLines } from './outbox.ts'
import { projects } from './projects.ts'
import { formatServiceRevisionDoctor } from './service-revision.ts'
import { formatTaskIdentityDoctor, taskIdentityDoctor } from './task-identity.ts'

export async function hubDoctorLines(): Promise<string[]> {
  const outbox = await hostedOutboxDoctorLines()
  return [
    `database       ${DB_PATH}`,
    `schema hash    ${canonicalSchemaHash(db()) === expectedSchemaHash() ? 'match' : 'DRIFT'}`,
    `schema version ${schemaVersionLabel(db())}`,
    ...formatTaskIdentityDoctor(taskIdentityDoctor()),
    ...formatServiceRevisionDoctor(),
    ...formatProjectWriteModes(projects(), readInstallBinding(), resolveHostedUrl()),
    ...outbox,
  ]
}
