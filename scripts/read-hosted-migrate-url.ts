import { resolveOperatorCredential } from '../orchestrator/src/config/operator-credential.ts'
import { credentialIdentityPath } from '../shared/credential.ts'
import {
  operatorCredentialResolveCommand,
  RECORD_MIGRATE_OPERATOR_CREDENTIAL,
} from '../shared/operator-credentials.ts'
import { secretResolutionFailure } from '../shared/secret-resolution-failure.ts'

const credential = RECORD_MIGRATE_OPERATOR_CREDENTIAL

if (process.stdout.isTTY) {
  console.error('REFUSE: this command writes a credential for command substitution only')
  process.exit(1)
}

let value: string | undefined
try {
  value = await resolveOperatorCredential(credential.identity, credential.overrideVariable)
} catch (error) {
  const cause = error instanceof Error ? error.message : String(error)
  console.error(
    secretResolutionFailure(error) ??
      `credential ${credentialIdentityPath(credential.identity.provider, credential.identity.name, credential.identity.type)} could not be resolved: ${cause}\ncleared by: ${operatorCredentialResolveCommand(credential)}`,
  )
  process.exit(2)
}

if (!value) process.exit(1)
process.stdout.write(value)
