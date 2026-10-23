// concern: record-auth-command
/** Owns record sign-in presentation and local bearer storage. Must not know run phases. */
import { writeRecordSessionToken } from '../../../shared/record-session.ts'
import { rememberHostedRecord } from './install-binding.ts'
import { recordApiClient, recordApiSignIn, recordApiSignUp } from './record-api-client.ts'
import { rememberSignedInRecordUser } from './record-session.ts'

type Presentation = { log(value: string): void }

export async function recordPassword(readPassword: () => Promise<string>): Promise<string> {
  const password = process.env.BOTTEGA_RECORD_PASSWORD ?? (await readPassword())
  if (!password) throw new Error('record password is required')
  return password
}

export async function signUpCommand(
  email: string,
  name: string,
  readPassword: () => Promise<string>,
  presentation: Presentation,
): Promise<void> {
  const result = await recordApiSignUp(email, name, await recordPassword(readPassword))
  writeRecordSessionToken(result.token)
  rememberSignedInRecordUser(result.user)
  rememberHostedRecord()
  presentation.log(`signed up ${result.user.email}`)
}

export async function signInCommand(
  email: string,
  readPassword: () => Promise<string>,
  presentation: Presentation,
): Promise<void> {
  const result = await recordApiSignIn(email, await recordPassword(readPassword))
  writeRecordSessionToken(result.token)
  rememberSignedInRecordUser(result.user)
  rememberHostedRecord()
  presentation.log(`signed in ${result.user.email}`)
}

export async function whoamiCommand(presentation: Presentation): Promise<void> {
  const identity = await recordApiClient().whoami()
  rememberSignedInRecordUser(identity.user)
  presentation.log(JSON.stringify(identity))
}
