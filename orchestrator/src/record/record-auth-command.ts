// concern: record-auth-command
/** Owns record sign-in presentation and local bearer storage. Must not know run phases. */
import { writeRecordSessionToken } from '../../../shared/record-session.ts'
import { RECORD_SIGN_IN_REMEDY, recordAuth, recordIdentity } from './record-auth.ts'
import { currentRecordSession } from './record-session.ts'

type Presentation = { log(value: string): void }

function recordUrl(): string {
  const url = process.env.ORCH_RECORD_URL
  if (!url) throw new Error('ORCH_RECORD_URL is required for record authentication')
  return url
}

export async function recordPassword(readPassword: () => Promise<string>): Promise<string> {
  const password = process.env.ORCH_RECORD_PASSWORD ?? (await readPassword())
  if (!password) throw new Error('record password is required')
  return password
}

export async function signUpCommand(
  email: string,
  name: string,
  readPassword: () => Promise<string>,
  presentation: Presentation,
): Promise<void> {
  const result = await recordAuth(recordUrl()).api.signUpEmail({
    body: { email, name, password: await recordPassword(readPassword) },
  })
  if (!result.token) throw new Error(RECORD_SIGN_IN_REMEDY)
  writeRecordSessionToken(result.token)
  presentation.log(`signed up ${result.user.email}`)
}

export async function signInCommand(
  email: string,
  readPassword: () => Promise<string>,
  presentation: Presentation,
): Promise<void> {
  const result = await recordAuth(recordUrl()).api.signInEmail({
    body: { email, password: await recordPassword(readPassword) },
  })
  writeRecordSessionToken(result.token)
  presentation.log(`signed in ${result.user.email}`)
}

export async function whoamiCommand(presentation: Presentation): Promise<void> {
  const url = recordUrl()
  const current = await currentRecordSession(url)
  presentation.log(JSON.stringify(await recordIdentity(url, current.user, current.activeSpaceId)))
}
