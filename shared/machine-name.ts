import { PLATFORM_SLUG } from './brand.ts'

const SHORT_NAME_RULE = '2-20 characters of [a-z0-9-], starting with a letter'
const DISPLAY_NAME_RULE = '1-60 characters'

export function shortNameRefusal(value: string): string | null {
  return /^[a-z][a-z0-9-]{1,19}$/.test(value) ? null : `short name must be ${SHORT_NAME_RULE}`
}

export function displayNameRefusal(value: string): string | null {
  return value.length >= 1 && value.length <= 60
    ? null
    : `display name must be ${DISPLAY_NAME_RULE}`
}

export function defaultShortName(hostname: string): string {
  let value = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(value)) value = `m-${value}`
  value = value.slice(0, 20).replace(/-+$/g, '')
  return value.length >= 2 ? value : `${value || 'm'}-machine`.slice(0, 20)
}

export type MachineNameClaim = { machineId: string; shortName: string; retired: boolean }
export type MachineNameClaimDecision =
  | { status: 'claim' }
  | { status: 'held-by-self' }
  | { status: 'refused'; reason: string }

export function decideMachineNameClaim(
  claims: readonly MachineNameClaim[],
  machineId: string,
  requestedName: string,
): MachineNameClaimDecision {
  const invalid = shortNameRefusal(requestedName)
  if (invalid) return { status: 'refused', reason: invalid }
  const held = claims.find((claim) => claim.shortName === requestedName)
  if (!held) return { status: 'claim' }
  if (held.machineId === machineId) return { status: 'held-by-self' }
  return {
    status: 'refused',
    reason: `short name ${requestedName} is held by machine ${held.machineId}${held.retired ? ' (retired)' : ''}; choose another with \`${PLATFORM_SLUG} machine rename --short-name <name>\``,
  }
}
