// concern: setup install verification decision
/** Classifies settings render results before install facts are verified. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type MachineSettingsApplyResult,
  settingsApplyResultWaitsForSignIn,
} from '../settings/settings-machine-apply.ts'

export type SetupInstallSettingsDecision =
  | { action: 'continue' }
  | { action: 'wait-for-sign-in'; message: string }
  | { action: 'refuse'; message: string }

const SIGN_IN_FOLLOW_UP =
  `not signed in: user settings and user canon wait for sign-in; run ` +
  `${PLATFORM_SLUG} record sign-in --email <email>, then re-run ${PLATFORM_SLUG} machine setup apply`

function refusedSettingsMessage(refused: readonly MachineSettingsApplyResult[]): string {
  return refused
    .map(
      (result) =>
        `${result.target}: ${result.condition ? `${result.condition}; ` : ''}${result.detail ?? 'refused'}`,
    )
    .join('\n')
}

export function setupInstallSettingsDecision(
  sessionPresent: boolean,
  results: readonly MachineSettingsApplyResult[],
): SetupInstallSettingsDecision {
  const refused = results.filter((result) => result.outcome === 'refused')
  if (refused.length === 0) return { action: 'continue' }
  if (!sessionPresent && refused.every(settingsApplyResultWaitsForSignIn)) {
    return { action: 'wait-for-sign-in', message: SIGN_IN_FOLLOW_UP }
  }
  return { action: 'refuse', message: refusedSettingsMessage(refused) }
}
