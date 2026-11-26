// concern: launch-agent liveness
/** Observes launch-agent loaded state and names the release-install verdict. */

import { startBoundedSync } from './bounded-process.ts'

export const NOT_INSTALLED_BY_RELEASE_INSTALL = 'not installed by a release install' as const

/** Observe one launch agent without treating an unavailable launchctl domain as unloaded. */
export function launchAgentLoaded(label: string): boolean | null {
  const launchctl = Bun.which('launchctl')
  const uid = process.getuid?.()
  if (!launchctl || uid === undefined) return null
  try {
    const domain = startBoundedSync([launchctl, 'print', `gui/${uid}`], {
      budget: 'process-table',
    })
    if (domain.exitCode !== 0) return null
    return (
      startBoundedSync([launchctl, 'print', `gui/${uid}/${label}`], {
        budget: 'process-table',
      }).exitCode === 0
    )
  } catch {
    return null
  }
}
