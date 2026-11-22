// concern: settings-subagents
/** Owns the signed-in user's subagent-blocking choice. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { subagentBlockingState } from '../../../shared/stored-settings.ts'
import { setDoc } from '../doc/docs.ts'
import {
  parseStoredOwnedSettings,
  SETTINGS_SCOPE,
  SETTINGS_SLUG,
  serializeOwnedSettings,
} from './settings.ts'
import { assertNoUnknownStoredSettingsEdit } from './settings-edit-refusal.ts'
import { readSignedInUserSettingsRow } from './settings-user-row.ts'

type SubagentResult = {
  blocking: 'on' | 'off'
  source: 'user' | 'default'
  changed: boolean
}

function subagentResult(
  options: ReturnType<typeof parseStoredOwnedSettings>['options'],
  changed: boolean,
): SubagentResult {
  return { ...subagentBlockingState(options), changed }
}

function editSubagentChoice(
  owned: ReturnType<typeof parseStoredOwnedSettings>,
  choice: string | undefined,
): SubagentResult {
  const current = owned.options?.subagentHooks === 'on'
  if (choice === undefined) return subagentResult(owned.options, false)
  const next = choice === 'block'
  if (next === current) return subagentResult(owned.options, false)
  if (next) owned.options = { ...owned.options, subagentHooks: 'on' }
  else {
    const remaining = { ...owned.options }
    delete remaining.subagentHooks
    owned.options = Object.keys(remaining).length ? remaining : undefined
  }
  return subagentResult(owned.options, true)
}

export async function settingsSubagentsCommand(
  choice?: string,
  adapters: { read?: typeof readSignedInUserSettingsRow } = {},
): Promise<SubagentResult> {
  if (choice !== undefined && choice !== 'allow' && choice !== 'block') {
    throw new Error('refusing settings subagents: expected allow or block')
  }
  const { owner, row } = await (adapters.read ?? readSignedInUserSettingsRow)()
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
