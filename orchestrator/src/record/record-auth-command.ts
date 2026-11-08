// concern: record-auth-command
/** Owns record sign-in presentation and local bearer storage. Must not know run phases. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { probeRecordSessionStore, writeRecordSessionToken } from '../../../shared/record-session.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { automaticallyAdoptHostedBoard } from '../board/board-auto-adoption.ts'
import { claimCurrentMachineKey } from '../config/config-service.ts'
import { adoptAllHostedProjectIdentities, formatProjectRelink } from '../project/project-relink.ts'
import { activeSpaceInvariant } from './active-space-invariant.ts'
import { rememberHostedRecord } from './install-binding-write.ts'
import {
  RecordApiRequestError,
  recordApiClient,
  recordApiSignIn,
  recordApiSignUp,
} from './record-api-client.ts'
import { recordApiSendVerificationEmail } from './record-email-verification-client.ts'
import { rememberSignedInRecordUser } from './record-session.ts'
import { recordMemberships } from './record-space.ts'

type Presentation = { log(value: string): void }

type VerificationEmailAction =
  | { action: 'already-verified'; email: string }
  | { action: 'send'; email: string }

export const RECORD_PASSWORD_ENV = `${PLATFORM_SLUG.toUpperCase()}_RECORD_PASSWORD`
const NON_INTERACTIVE_PASSWORD_REFUSAL = `record password is required: stdin is not a terminal; set ${RECORD_PASSWORD_ENV} to supply it non-interactively`
export const PASSWORD_PROMPT_EOF_REFUSAL = `record password prompt ended before a password was entered; set ${RECORD_PASSWORD_ENV} to supply it non-interactively`

type RecordPasswordDecision =
  | { action: 'use-environment'; password: string }
  | { action: 'prompt' }
  | { action: 'refuse'; message: string }

type RecordAuthCommandDependencies = {
  probeSessionStore(): void
  signIn(email: string, password: string): Promise<RecordSessionResult>
  signUp(email: string, name: string, password: string): Promise<RecordSessionResult>
}

type RecordSessionResult = { token: string; user: Record<string, unknown> }

const recordAuthCommandDependencies: RecordAuthCommandDependencies = {
  probeSessionStore: probeRecordSessionStore,
  signIn: recordApiSignIn,
  signUp: recordApiSignUp,
}

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
  dependencies: RecordAuthCommandDependencies = recordAuthCommandDependencies,
): Promise<void> {
  const password = await recordPassword(readPassword)
  dependencies.probeSessionStore()
  let result: RecordSessionResult
  try {
    result = await dependencies.signUp(email, name, password)
  } catch (error) {
    throw existingAccountSignUpRefusal(error, email)
  }
  await completeRecordSessionCommand(result, presentation, 'signed up')
}

function existingAccountSignUpRefusal(error: unknown, email: string): unknown {
  const code = error instanceof RecordApiRequestError ? error.code : null
  const message = error instanceof Error ? error.message : String(error)
  const existingAccount = code
    ? code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' || code === 'USER_ALREADY_EXISTS'
    : message.startsWith('User already exists')
  if (!existingAccount) return error
  return new Error(
    renderRefusal(
      refusal(message, {
        kind: 'command',
        argv: [PLATFORM_SLUG, 'record', 'sign-in', '--email', email],
      }),
    ),
  )
}

async function completeRecordSessionCommand(
  result: { token: string; user: Record<string, unknown> },
  presentation: Presentation,
  completion: 'signed in' | 'signed up',
): Promise<void> {
  writeRecordSessionToken(result.token)
  rememberSignedInRecordUser(result.user)
  rememberHostedRecord()
  const identity = await recordMemberships()
  const active = activeSpaceInvariant(identity)
  if (!active.holds) throw new Error(active.message)
  presentation.log(`${completion} ${result.user.email}`)
  presentation.log(`active record space ${active.active?.slug ?? active.active?.spaceId ?? 'none'}`)
}

async function completeSignedInMachineSetup(presentation: Presentation): Promise<void> {
  try {
    await claimCurrentMachineKey()
  } catch (error) {
    presentation.log(
      `machine key claim failed: ${error instanceof Error ? error.message : String(error)}`,
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
  await automaticallyAdoptHostedBoard(presentation, { signedIn: () => true })
}

export async function signInCommand(
  email: string,
  readPassword: () => Promise<string>,
  presentation: Presentation,
  dependencies: RecordAuthCommandDependencies = recordAuthCommandDependencies,
): Promise<void> {
  const password = await recordPassword(readPassword)
  dependencies.probeSessionStore()
  const result = await dependencies.signIn(email, password)
  await completeSignInCommand(result, presentation)
}

export async function completeSignInCommand(
  result: { token: string; user: Record<string, unknown> },
  presentation: Presentation,
): Promise<void> {
  await completeRecordSessionCommand(result, presentation, 'signed in')
  await completeSignedInMachineSetup(presentation)
}

export async function whoamiCommand(presentation: Presentation): Promise<void> {
  const identity = await recordApiClient().whoami()
  rememberSignedInRecordUser(identity.user)
  presentation.log(JSON.stringify(identity))
}

export function verificationEmailAction(user: Record<string, unknown>): VerificationEmailAction {
  if (typeof user.email !== 'string' || typeof user.emailVerified !== 'boolean')
    throw new Error('record API returned an invalid identity')
  return user.emailVerified
    ? { action: 'already-verified', email: user.email }
    : { action: 'send', email: user.email }
}

export async function verifyEmailCommand(
  presentation: Presentation,
  dependencies = {
    identity: () => recordApiClient().whoami(),
    send: recordApiSendVerificationEmail,
  },
): Promise<void> {
  const decision = verificationEmailAction((await dependencies.identity()).user)
  if (decision.action === 'already-verified') {
    presentation.log(`${decision.email} is already verified`)
    return
  }
  await dependencies.send(decision.email)
  presentation.log(`verification mail sent to ${decision.email}`)
}
