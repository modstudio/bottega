// concern: settings-edit-refusal
/** Renders the forward-compatibility refusal shared by settings row edit adapters. */
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { unknownStoredSettingsTopLevelKey } from './settings.ts'

export function refuseUnknownStoredSettingsEdit(body: string): string | null {
  const unknown = unknownStoredSettingsTopLevelKey(body)
  if (unknown === null) return null
  return renderRefusal(
    refusal(
      `refusing settings edit: stored settings row has unknown key ${JSON.stringify(unknown)}`,
      {
        kind: 'edit',
        text: `upgrade ${PLATFORM_NAME} before editing this settings row`,
      },
    ),
  )
}
