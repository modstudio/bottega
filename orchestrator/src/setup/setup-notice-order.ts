// concern: setup-notice-order
/** Orders setup notices by whether their remedy is required for something to work. */
import type { SetupNotice } from './setup-engine.ts'

const BLOCKING_NOTICE = [
  'git is missing',
  'gh is missing',
  'harness is not installed',
  'gh is signed out',
  'git inspection timed out',
]

export function orderSetupNotices(notices: readonly SetupNotice[]): SetupNotice[] {
  return [...notices].sort(
    (left, right) =>
      Number(BLOCKING_NOTICE.some((text) => right.message.includes(text))) -
      Number(BLOCKING_NOTICE.some((text) => left.message.includes(text))),
  )
}
