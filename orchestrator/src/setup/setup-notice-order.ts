// concern: setup-notice-order
/** Orders setup notices by whether their remedy is required for something to work. */
import type { SetupNotice } from './setup-engine.ts'

export function orderSetupNotices(notices: readonly SetupNotice[]): SetupNotice[] {
  return [...notices].sort((left, right) => Number(right.blocking) - Number(left.blocking))
}
