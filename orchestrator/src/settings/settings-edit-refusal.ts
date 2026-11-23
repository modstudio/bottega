// concern: settings-edit-refusal
/** Renders the forward-compatibility refusal shared by settings row edit adapters. */
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { storedSettingsUpgradeRemedy } from '../../../shared/stored-settings.ts'
import { unknownStoredSettingsKeyPath } from './settings.ts'

export function refuseUnknownStoredSettingsEdit(body: string): string | null {
  const unknown = unknownStoredSettingsKeyPath(body)
  if (unknown === null) return null
  return renderRefusal(
    refusal(
      `refusing settings edit: stored settings row has unknown key ${JSON.stringify(unknown)}`,
      {
        kind: 'edit',
        text: storedSettingsUpgradeRemedy('editing'),
      },
    ),
  )
}

export function assertNoUnknownStoredSettingsEdit(body: string): void {
  const refusal = refuseUnknownStoredSettingsEdit(body)
  if (refusal) throw new Error(refusal)
}
