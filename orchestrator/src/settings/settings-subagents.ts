// concern: settings-subagents
/** Owns the signed-in user's subagent-blocking choice. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { getDocStore as getDoc } from '../doc/doc-read-store.ts'
import { setDoc, signedInDocOwner } from '../doc/docs.ts'
import {
  parseStoredOwnedSettings,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  serializeOwnedSettings,
} from './settings.ts'
import { assertNoUnknownStoredSettingsEdit } from './settings-edit-refusal.ts'

export type SubagentBlockingChoice = 'allow' | 'block'

export async function settingsSubagentsCommand(
  choice?: string,
): Promise<{ blocking: 'on' | 'off'; source: 'user' | 'default'; changed: boolean }> {
  if (choice !== undefined && choice !== 'allow' && choice !== 'block') {
    throw new Error('refusing settings subagents: expected allow or block')
  }
  const owner = await signedInDocOwner()
  const row = getDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
  if (!row) {
    throw new Error(
      `refusing settings subagents: no user settings row\ncleared by: run \`${PLATFORM_SLUG} machine settings import --user\``,
    )
  }
  assertNoUnknownStoredSettingsEdit(row.body)
  const owned = parseStoredOwnedSettings(row.body)
  const current = owned.options?.subagentHooks === 'on'
  if (choice === undefined) {
    return {
      blocking: current ? 'on' : 'off',
      source: current ? 'user' : 'default',
      changed: false,
    }
  }
  const next = choice === 'block'
  if (next === current) {
    return { blocking: next ? 'on' : 'off', source: next ? 'user' : 'default', changed: false }
  }
  if (next) owned.options = { ...owned.options, subagentHooks: 'on' }
  else {
    const remaining = { ...owned.options }
    delete remaining.subagentHooks
    owned.options = Object.keys(remaining).length ? remaining : undefined
  }
  await setDoc({
    scope: SETTINGS_SCOPE,
    subject: null,
    owner,
    slug: SETTINGS_SLUG,
    title: SETTINGS_SLUG,
    body: serializeOwnedSettings(owned),
    delivery: 'demand',
    reason: `${choice} Claude subagents`,
    expectedRevision: row.revision!,
  })
  return { blocking: next ? 'on' : 'off', source: next ? 'user' : 'default', changed: true }
}
