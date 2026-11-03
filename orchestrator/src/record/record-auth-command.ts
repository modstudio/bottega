// concern: record-auth-command
/** Owns record sign-in presentation and local bearer storage. Must not know run phases. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { writeRecordSessionToken } from '../../../shared/record-session.ts'
import { rememberHostedRecord } from './install-binding-write.ts'
import { recordApiClient, recordApiSignIn, recordApiSignUp } from './record-api-client.ts'
import { rememberSignedInRecordUser } from './record-session.ts'

type Presentation = { log(value: string): void }

export const RECORD_PASSWORD_ENV = `${PLATFORM_SLUG.toUpperCase()}_RECORD_PASSWORD`
export const NON_INTERACTIVE_PASSWORD_REFUSAL = `record password is required: stdin is not a terminal; set ${RECORD_PASSWORD_ENV} to supply it non-interactively`

type RecordPasswordDecision =
  | { action: 'use-environment'; password: string }
  | { action: 'prompt' }
  | { action: 'refuse'; message: string }

export function decideRecordPassword(
  passwordFromEnvironment: string | undefined,
  stdinIsTerminal: boolean,
): RecordPasswordDecision {
  if (passwordFromEnvironment !== undefined) {
    return { action: 'use-environment', password: passwordFromEnvironment }
  }
  if (stdinIsTerminal) return { action: 'prompt' }
  return { action: 'refuse', message: NON_INTERACTIVE_PASSWORD_REFUSAL }
}

export async function recordPassword(readPassword: () => Promise<string>): Promise<string> {
  const decision = decideRecordPassword(
    process.env[RECORD_PASSWORD_ENV],
    process.stdin.isTTY === true,
  )
  if (decision.action === 'refuse') throw new Error(decision.message)
  const password = decision.action === 'use-environment' ? decision.password : await readPassword()
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
