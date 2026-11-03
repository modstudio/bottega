// concern: record-auth-command
/** Owns record sign-in presentation and local bearer storage. Must not know run phases. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { writeRecordSessionToken } from '../../../shared/record-session.ts'
import { claimCurrentMachineKey } from '../config/config-service.ts'
import { adoptAllHostedProjectIdentities, formatProjectRelink } from '../project/project-relink.ts'
import { rememberHostedRecord } from './install-binding-write.ts'
import { recordApiClient, recordApiSignIn, recordApiSignUp } from './record-api-client.ts'
import { rememberSignedInRecordUser } from './record-session.ts'

type Presentation = { log(value: string): void }

export const RECORD_PASSWORD_ENV = `${PLATFORM_SLUG.toUpperCase()}_RECORD_PASSWORD`
const NON_INTERACTIVE_PASSWORD_REFUSAL = `record password is required: stdin is not a terminal; set ${RECORD_PASSWORD_ENV} to supply it non-interactively`
export const PASSWORD_PROMPT_EOF_REFUSAL = `record password prompt ended before a password was entered; set ${RECORD_PASSWORD_ENV} to supply it non-interactively`

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
  const password = process.env[RECORD_PASSWORD_ENV] ?? (await readPassword())
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
  await completeSignInCommand(result, presentation)
}

export async function completeSignInCommand(
  result: { token: string; user: Record<string, unknown> },
  presentation: Presentation,
): Promise<void> {
  writeRecordSessionToken(result.token)
  rememberSignedInRecordUser(result.user)
  rememberHostedRecord()
  presentation.log(`signed in ${result.user.email}`)
  try {
    await claimCurrentMachineKey()
  } catch (error) {
    presentation.log(
      `machine key claim failed: ${error instanceof Error ? error.message : String(error)}; run \`${PLATFORM_SLUG} machine config machine init\``,
    )
  }
  for (const adoption of await adoptAllHostedProjectIdentities()) {
    if (adoption.status === 'relinked') presentation.log(formatProjectRelink(adoption))
    else if (adoption.status === 'retired-namesake') presentation.log(adoption.message)
    else if (adoption.status === 'failed')
      presentation.log(
        `${adoption.name}: project identity adoption failed: ${adoption.message}; run \`${PLATFORM_SLUG} project relink ${adoption.name}\``,
      )
  }
}

export async function whoamiCommand(presentation: Presentation): Promise<void> {
  const identity = await recordApiClient().whoami()
  rememberSignedInRecordUser(identity.user)
  presentation.log(JSON.stringify(identity))
}
