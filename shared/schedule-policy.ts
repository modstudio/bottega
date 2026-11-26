// concern: schedule-policy
/** Pure schedule identities and installation expectations shared across concerns. */

export const COLLECT_SCHEDULE_LABEL = 'com.user.hub-collect' as const

export const MAINTENANCE_SCHEDULE_LABELS = [
  'com.user.orch-sweep',
  'com.user.orch-record-sync',
  COLLECT_SCHEDULE_LABEL,
] as const

export type MaintenanceScheduleLabel = (typeof MAINTENANCE_SCHEDULE_LABELS)[number]

export const LONG_RUNNING_MAINTENANCE_LABELS = [
  COLLECT_SCHEDULE_LABEL,
] as const satisfies readonly MaintenanceScheduleLabel[]

export const LAUNCHD_TEMPLATE_PATHS: Record<MaintenanceScheduleLabel, string> = {
  'com.user.orch-sweep': 'ops/launchd/com.user.orch-sweep.plist.template',
  'com.user.orch-record-sync': 'ops/launchd/com.user.orch-record-sync.plist.template',
  [COLLECT_SCHEDULE_LABEL]: 'hub/launchd/com.user.hub-collect.plist.template',
}

export const SYSTEMD_TEMPLATE_DIRECTORY = 'ops/systemd'
export const SYSTEMD_UNIT_SUFFIXES = ['.service', '.timer', '.path'] as const
const SYSTEMD_ACTIVATION_UNIT_SUFFIXES = ['.timer', '.path'] as const

export const SYSTEMD_UNITS: Record<MaintenanceScheduleLabel, readonly string[]> = {
  'com.user.orch-sweep': ['orch-sweep.service', 'orch-sweep.timer'],
  'com.user.orch-record-sync': [
    'orch-record-sync.service',
    'orch-record-sync.timer',
    'orch-record-sync.path',
  ],
  [COLLECT_SCHEDULE_LABEL]: ['hub-collect.service'],
}

export function systemdActivationUnits(label: MaintenanceScheduleLabel): string[] {
  const units = SYSTEMD_UNITS[label]
  const activationUnits = units.filter((name) =>
    SYSTEMD_ACTIVATION_UNIT_SUFFIXES.some((suffix) => name.endsWith(suffix)),
  )
  return activationUnits.length > 0
    ? activationUnits
    : units.filter((name) => name.endsWith('.service'))
}

export function schedulePlatformSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

const maintenanceScheduleLabels = new Set<string>(MAINTENANCE_SCHEDULE_LABELS)

export function isMaintenanceScheduleLabel(label: string): label is MaintenanceScheduleLabel {
  return maintenanceScheduleLabels.has(label)
}

export const NOT_SCHEDULED_BY_THIS_INSTALL = 'not scheduled by this install' as const
export const SCHEDULED_BY_THIS_INSTALL = { scheduled: true, reason: null } as const

export const MAINTENANCE_SCHEDULE_DESCRIPTION =
  'scheduled sweep, record sync, and hub collection' as const

export type CheckoutScheduleOwnerFact = {
  label: string
  checkoutOnly: boolean
}

export type ScheduleExpectation =
  | { scheduled: true; reason: null }
  | { scheduled: false; reason: typeof NOT_SCHEDULED_BY_THIS_INSTALL }

/** Answer whether this install owns a label through a checkout-only darwin installer. */
export function checkoutOnlyOwnerOwnsLabel(
  label: string,
  platform: NodeJS.Platform,
  installationKind: 'distribution' | 'checkout' | null,
  checkoutOwners: readonly CheckoutScheduleOwnerFact[],
): boolean {
  return (
    installationKind === 'checkout' &&
    platform === 'darwin' &&
    checkoutOwners.some((owner) => owner.label === label && owner.checkoutOnly)
  )
}

/** Answer whether this installation owns a schedule on this platform. */
export function scheduleExpectation(
  label: string,
  platform: NodeJS.Platform,
  installationKind: 'distribution' | 'checkout' | null,
  machineLevel: 'record' | 'full',
  checkoutOwners: readonly CheckoutScheduleOwnerFact[],
): ScheduleExpectation {
  const scheduled =
    schedulePlatformSupported(platform) &&
    (installationKind === 'distribution'
      ? machineLevel === 'full' && isMaintenanceScheduleLabel(label)
      : checkoutOnlyOwnerOwnsLabel(label, platform, installationKind, checkoutOwners))
  return scheduled
    ? SCHEDULED_BY_THIS_INSTALL
    : { scheduled: false, reason: NOT_SCHEDULED_BY_THIS_INSTALL }
}
