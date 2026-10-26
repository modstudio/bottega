// concern: settings-env-commands
/** Owns edits to plain canonical user settings environment values. */
import { getDoc, setDoc, signedInDocOwner } from '../doc/docs.ts'
import {
  editSettingsEnv,
  parseStoredOwnedSettings,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  type SettingsEnvOperation,
  serializeOwnedSettings,
} from './settings.ts'

export type { SettingsEnvOperation } from './settings.ts'

export async function settingsEnvCommand(
  operation: SettingsEnvOperation,
  name: string,
  value?: string,
): Promise<{ changed: boolean; revision: string; message: string }> {
  const owner = await signedInDocOwner()
  const row = getDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
  if (!row) throw new Error(`refusing settings env ${operation}: no user settings row`)
  const edit = editSettingsEnv(parseStoredOwnedSettings(row.body), { operation, name, value })
  if (!edit.changed) {
    return { changed: false, revision: row.revision!, message: edit.message }
  }
  const written = await setDoc({
    scope: SETTINGS_SCOPE,
    subject: null,
    owner,
    slug: SETTINGS_SLUG,
    title: SETTINGS_SLUG,
    body: serializeOwnedSettings(edit.settings),
    delivery: 'demand',
    reason: `${operation === 'set' ? 'set' : 'unset'} plain settings environment value`,
    expectedRevision: row.revision!,
  })
  return {
    changed: true,
    revision: written.revision!,
    message: edit.message,
  }
}
