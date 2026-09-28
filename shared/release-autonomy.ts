/** Values accepted by every release-autonomy boundary. */
export const RELEASE_AUTONOMY_VALUES = ['push', 'land', 'promote'] as const

export type ReleaseAutonomyValue = (typeof RELEASE_AUTONOMY_VALUES)[number]

export const isReleaseAutonomyValue = (value: unknown): value is ReleaseAutonomyValue =>
  typeof value === 'string' && RELEASE_AUTONOMY_VALUES.includes(value as ReleaseAutonomyValue)
