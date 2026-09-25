import { DB_PATH, db } from './db.ts'
import { formatProjectWriteModes } from './hosted-write-mode.ts'
import { readInstallBinding } from './install-binding.ts'
import { canonicalSchemaHash, expectedSchemaHash, schemaVersionLabel } from './migrations.ts'
import { projects } from './projects.ts'
import { formatServiceRevisionDoctor } from './service-revision.ts'
import { formatTaskIdentityDoctor, taskIdentityDoctor } from './task-identity.ts'

export function hubDoctorLines(): string[] {
  return [
    `database       ${DB_PATH}`,
    `schema hash    ${canonicalSchemaHash(db()) === expectedSchemaHash() ? 'match' : 'DRIFT'}`,
    `schema version ${schemaVersionLabel(db())}`,
    ...formatTaskIdentityDoctor(taskIdentityDoctor()),
    ...formatServiceRevisionDoctor(),
    ...formatProjectWriteModes(projects(), readInstallBinding(), process.env.HUB_HOSTED_URL),
  ]
}
