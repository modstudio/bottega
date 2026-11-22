// concern: settings-subagents
/** Owns the signed-in user's subagent-blocking choice. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { getDocStore as getDoc } from '../doc/doc-read-store.ts'
import { setDoc, signedInDocOwner } from '../doc/docs.ts'
import {
  parseStoredOwnedSettings,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  serializeOwnedSettings,
} from './settings.ts'
import { assertNoUnknownStoredSettingsEdit } from './settings-edit-refusal.ts'

type SubagentResult = {
  blocking: 'on' | 'off'
  source: 'user' | 'default'
  changed: boolean
}

function subagentResult(on: boolean, changed: boolean): SubagentResult {
  return { blocking: on ? 'on' : 'off', source: on ? 'user' : 'default', changed }
}

function editSubagentChoice(
  owned: ReturnType<typeof parseStoredOwnedSettings>,
  choice: string | undefined,
): SubagentResult {
  const current = owned.options?.subagentHooks === 'on'
  if (choice === undefined) return subagentResult(current, false)
  const next = choice === 'block'
  if (next === current) return subagentResult(next, false)
  if (next) owned.options = { ...owned.options, subagentHooks: 'on' }
  else {
    const remaining = { ...owned.options }
    delete remaining.subagentHooks
    owned.options = Object.keys(remaining).length ? remaining : undefined
  }
  return subagentResult(next, true)
}

export async function settingsSubagentsCommand(choice?: string): Promise<SubagentResult> {
  if (choice !== undefined && choice !== 'allow' && choice !== 'block') {
    throw new Error('refusing settings subagents: expected allow or block')
  }
  const owner = await signedInDocOwner()
  const row = getDoc(SETTINGS_SCOPE, null, SETTINGS_SLUG, owner)
  if (!row) {
    throw new Error(
      renderRefusal(
        refusal('refusing settings subagents: no user settings row', {
          kind: 'command',
          argv: [PLATFORM_SLUG, 'machine', 'settings', 'import', '--user'],
        }),
      ),
    )
  }
  assertNoUnknownStoredSettingsEdit(row.body)
  const owned = parseStoredOwnedSettings(row.body)
  const result = editSubagentChoice(owned, choice)
  if (!result.changed) return result
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
  return result
}
