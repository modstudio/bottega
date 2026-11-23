// concern: settings-user-row
/** Reads the signed-in user's settings row through the active record authority. */
import { readDoc } from '../doc/doc-authoritative-read.ts'
import { signedInDocOwner } from '../doc/docs.ts'
import {
  parseStoredOwnedSettings,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  type OwnedSettings,
} from './settings.ts'

type UserSettingsRow = { body: string; revision: string | null }

export async function readSignedInUserSettingsRow(): Promise<{
  owner: string
  row: UserSettingsRow | null
}> {
  const owner = await signedInDocOwner()
  const row = await readDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
  return { owner, row }
}

export async function readSignedInSettingsOptions(): Promise<OwnedSettings['options']> {
  const { row } = await readSignedInUserSettingsRow()
  return row ? parseStoredOwnedSettings(row.body).options : undefined
}
