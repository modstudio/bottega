import { resolveOperatorCredential } from '../orchestrator/src/config/operator-credential.ts'
import { PLATFORM_SLUG } from '../shared/brand.ts'
import { RECORD_MIGRATE_SECRET_NAME } from '../shared/record-migrate-secret.ts'
import { secretResolutionFailure } from '../shared/secret-resolution-failure.ts'

const name = RECORD_MIGRATE_SECRET_NAME

if (process.stdout.isTTY) {
  console.error('REFUSE: this command writes a credential for command substitution only')
  process.exit(1)
}

let value: string | undefined
try {
  value = await resolveOperatorCredential(
    { provider: 'postgres', name: 'owner', type: 'url' },
    name,
  )
} catch (error) {
  const cause = error instanceof Error ? error.message : String(error)
  console.error(
    secretResolutionFailure(error) ??
      `credential postgres/owner/url could not be resolved: ${cause}\ncleared by: ${PLATFORM_SLUG} record doctor`,
  )
  process.exit(2)
}

if (!value) process.exit(1)
process.stdout.write(value)
