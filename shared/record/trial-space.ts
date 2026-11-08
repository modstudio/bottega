// concern: hosted-trial-space-marker
/** One definition of the hosted marker and identifier reserved for disposable trial spaces. */
export const TRIAL_IDENTIFIER_PREFIX = 'trial-'
export const TRIAL_SPACE_MARKER_KEY = 'trial'

export function isTrialSpaceMetadata(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false
  const marker = (metadata as Record<string, unknown>)[TRIAL_SPACE_MARKER_KEY]
  return typeof marker === 'object' && marker !== null
}
