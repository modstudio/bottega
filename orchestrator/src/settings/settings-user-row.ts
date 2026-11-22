// concern: settings-user-row
/** Reads the signed-in user's settings row through the active record authority. */
import { readDoc, readDocHistory } from '../doc/doc-authoritative-read.ts'
import { signedInDocOwner } from '../doc/docs.ts'
import { parseStoredOwnedSettings, SETTINGS_SCOPE, SETTINGS_SLUG } from './settings.ts'

type UserSettingsRow = { body: string; revision: string | null }

export async function readSignedInUserSettingsRow(): Promise<{
  owner: string
  row: UserSettingsRow | null
}> {
  const owner = await signedInDocOwner()
  const row = await readDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
  if (!row || row.revision) return { owner, row }
  const history = await readDocHistory(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
  return {
    owner,
    row: { body: row.body, revision: history?.revisions[0]?.record_id ?? null },
  }
}

export async function readSignedInSubagentHooks(): Promise<'on' | undefined> {
  const { row } = await readSignedInUserSettingsRow()
  return row ? parseStoredOwnedSettings(row.body).options?.subagentHooks : undefined
}
