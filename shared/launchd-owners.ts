// concern: launchd installer ownership
/** Names launchd template owners and classifies checkout-only installers. */

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

export const LAUNCHD_TEMPLATE_OWNERS = [
  { concern: 'hub', directory: 'launchd', command: 'hub/bin/install-launchd.sh' },
  { concern: 'ops', directory: 'launchd', command: 'ops/install.sh' },
] as const

/** Return the canonical launchd template owner for one installer concern. */
export function launchdOwnerCommand(concern: string): string {
  const owner = LAUNCHD_TEMPLATE_OWNERS.find((candidate) => candidate.concern === concern)
  if (!owner) throw new Error(`no launchd template owner for concern ${concern}`)
  return owner.command
}

const CHECKOUT_ONLY_INSTALLERS = new Set<string>(
  LAUNCHD_TEMPLATE_OWNERS.map(({ command }) => command),
)

/** Answer whether an owner command exists only in a source checkout. */
export function isCheckoutOnlyLaunchAgentInstaller(command: string): boolean {
  return CHECKOUT_ONLY_INSTALLERS.has(command)
}
