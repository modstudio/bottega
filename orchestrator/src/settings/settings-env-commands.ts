// concern: settings-env-commands
/** Owns edits to plain canonical user settings environment values. */
import { getDoc, setDoc, signedInDocOwner } from '../doc/docs.ts'
import {
  ENV_NAME,
  parseStoredOwnedSettings,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  serializeOwnedSettings,
} from './settings.ts'

export type SettingsEnvOperation = 'set' | 'unset'

export async function settingsEnvCommand(
  operation: SettingsEnvOperation,
  name: string,
  value?: string,
): Promise<{ changed: boolean; revision: string; message: string }> {
  if (!ENV_NAME.test(name))
    throw new Error(`refusing settings env ${operation}: invalid name ${name}`)
  if (operation === 'set' && value === undefined) {
    throw new Error('refusing settings env set: value is required')
  }
  const owner = await signedInDocOwner()
  const row = getDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
  if (!row) throw new Error(`refusing settings env ${operation}: no user settings row`)
  const owned = parseStoredOwnedSettings(row.body)
  const current = owned.env ?? {}
  if (operation === 'unset' && !Object.hasOwn(current, name)) {
    return { changed: false, revision: row.revision!, message: `${name} is absent` }
  }
  if (operation === 'set' && current[name] === value) {
    return { changed: false, revision: row.revision!, message: `${name} is already current` }
  }
  owned.env = Object.fromEntries(
    Object.entries(
      operation === 'set'
        ? { ...current, [name]: value! }
        : Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== name)),
    ).sort(([left], [right]) => left.localeCompare(right)),
  )
  const written = await setDoc({
    scope: SETTINGS_SCOPE,
    subject: null,
    owner,
    slug: SETTINGS_SLUG,
    title: SETTINGS_SLUG,
    body: serializeOwnedSettings(owned),
    delivery: 'demand',
    reason: `${operation === 'set' ? 'set' : 'unset'} plain settings environment value`,
    expectedRevision: row.revision!,
  })
  return {
    changed: true,
    revision: written.revision!,
    message: `${operation === 'set' ? 'set' : 'unset'} ${name}`,
  }
}
