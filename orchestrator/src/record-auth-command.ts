// concern: record-auth-command
/** Owns record sign-in presentation and local bearer storage. Must not know run phases. */
import { SQL } from 'bun'
import { db, writeTransaction } from './db.ts'
import {
  currentRecordSession,
  RECORD_SESSION_KEY,
  RECORD_SIGN_IN_REMEDY,
  recordAuth,
} from './record-auth.ts'

type Presentation = { log(value: string): void }

function recordUrl(): string {
  const url = process.env.ORCH_RECORD_URL
  if (!url) throw new Error('ORCH_RECORD_URL is required for record authentication')
  return url
}

function storeRecordToken(token: string): void {
  writeTransaction(() => {
    db()
      .query(
        `INSERT INTO schema_meta (key,value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(RECORD_SESSION_KEY, token)
  })
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
  storeRecordToken(result.token)
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
  storeRecordToken(result.token)
  presentation.log(`signed in ${result.user.email}`)
}

export async function whoamiCommand(presentation: Presentation): Promise<void> {
  const url = recordUrl()
  const current = await currentRecordSession(url)
  const sql = new SQL(url)
  try {
    const memberships = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${current.user.id}, true)`
      await tx`SELECT set_config('app.space_id', ${current.activeSpaceId}, true)`
      return tx`
        SELECT s.id AS space_id, s.name, s.slug, m.role, m.permission
        FROM membership m JOIN space s ON s.id=m.space_id
        WHERE m.user_id=${current.user.id}::uuid ORDER BY s.slug
      `
    })
    presentation.log(
      JSON.stringify({
        user: current.user,
        activeSpaceId: current.activeSpaceId,
        memberships,
      }),
    )
  } finally {
    await sql.close()
  }
}
