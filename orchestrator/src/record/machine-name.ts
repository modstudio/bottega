import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { StoredMachineNames } from '../../../shared/machine-config.ts'

const SHORT_NAME_RULE = '2-20 characters of [a-z0-9-], starting with a letter'
const DISPLAY_NAME_RULE = '1-60 characters'

export function shortNameRefusal(value: string): string | null {
  return /^[a-z][a-z0-9-]{1,19}$/.test(value) ? null : `short name must be ${SHORT_NAME_RULE}`
}

export type MachineIdentifierNames = Pick<StoredMachineNames, 'shortName' | 'formerShortNames'>
export type MachineNamePair = Pick<StoredMachineNames, 'shortName' | 'displayName'>

export type MachineLabelDecision =
  | { kind: 'bare'; remainder: string }
  | { kind: 'not-label' }
  | { kind: 'refused'; reason: string }

export class MachineLabelRefusal extends Error {}

export function decideMachineLabel(
  input: string,
  names: MachineIdentifierNames | null,
): MachineLabelDecision {
  const match = /^([^/]+)\/(.+)$/.exec(input)
  if (!match) return { kind: 'not-label' }
  const name = match[1]!
  const unnamedMachinePrefix = /^[0-9a-f]{8}$/.test(name) && shortNameRefusal(name) !== null
  if (shortNameRefusal(name) && !unnamedMachinePrefix) return { kind: 'not-label' }
  if (!names)
    return {
      kind: 'refused',
      reason: `this machine has no short name because it has not joined a space; a bare number or UUID works meanwhile; set the name by joining a space with \`${PLATFORM_SLUG} record space switch --short-name <name>\``,
    }
  if (unnamedMachinePrefix)
    return {
      kind: 'refused',
      reason: `\`${input}\` names a row on an unnamed machine with id prefix \`${name}\`; this command acts only on this machine's (\`${names.shortName}\`) rows`,
    }
  if (name === names.shortName || names.formerShortNames.includes(name))
    return { kind: 'bare', remainder: match[2]! }
  return {
    kind: 'refused',
    reason: `\`${input}\` names a row on machine \`${name}\`; this command acts only on this machine's (\`${names.shortName}\`) rows`,
  }
}

export function stripMachineLabel(input: string, names: MachineIdentifierNames | null): string {
  const label = decideMachineLabel(input, names)
  if (label.kind === 'refused') throw new MachineLabelRefusal(label.reason)
  return label.kind === 'bare' ? label.remainder : input
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

export type MachineNameClaim = {
  machineId: string
  shortName: string
  displayName: string
  retired: boolean
}
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
    reason: `short name ${requestedName} is held by ${held.displayName} (${held.shortName})${held.retired ? ', retired' : ''}; choose another with \`${PLATFORM_SLUG} machine rename --short-name <name>\``,
  }
}
