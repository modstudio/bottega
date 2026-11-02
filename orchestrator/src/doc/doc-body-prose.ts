// concern: document prose policy
/** Decides whether a document body is prose or a machine-structured payload. */

import { SETTINGS_SCOPE } from '../settings/settings.ts'

export function docBodyIsProse(scope: string): boolean {
  return scope !== SETTINGS_SCOPE
}
