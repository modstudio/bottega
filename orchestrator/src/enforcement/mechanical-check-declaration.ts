// concern: mechanical-check-declaration
/** Owns the stored mechanical-check declaration grammar and its pure refusal decisions. */

import {
  ENFORCEMENT_POINTS,
  type EnforcementPoint,
  MECHANICAL_CHECK_CATALOGUE,
  MECHANICAL_CHECK_CATEGORIES,
  type MechanicalCheckCategory,
} from './enforcement-catalogue.ts'

export type MechanicalCheckOverride = {
  tool?: string
  points?: EnforcementPoint[]
  blocking?: boolean
  limit?: number
  note?: string
}

export type MechanicalCheckEntry = MechanicalCheckOverride | { optOut: { reason: string } }

export type MechanicalCheckValidationIssue = { path: PropertyKey[]; message: string }

const MECHANICAL_CHECK_OVERRIDE_FIELDS = [
  'tool',
  'points',
  'blocking',
  'limit',
  'note',
] as const satisfies readonly (keyof MechanicalCheckOverride)[]

const mechanicalCheckIssue = (
  identifier: string,
  message: string,
  field?: string,
): MechanicalCheckValidationIssue => ({
  path: field ? [identifier, field] : [identifier],
  message,
})

function optOutIssues(
  identifier: string,
  entry: Record<string, unknown>,
  mode: 'strict' | 'strip',
): MechanicalCheckValidationIssue[] {
  const issues: MechanicalCheckValidationIssue[] = []
  // A known override field beside optOut is always a mistake; a key this
  // binary does not know is a mistake only where a write is being judged.
  const mixed = Object.keys(entry).filter(
    (key) =>
      key !== 'optOut' &&
      (mode === 'strict' || MECHANICAL_CHECK_OVERRIDE_FIELDS.includes(key as never)),
  )
  if (mixed.length) {
    issues.push(
      mechanicalCheckIssue(
        identifier,
        `optOut cannot be mixed with override fields: ${mixed.sort().join(', ')}`,
      ),
    )
  }
  const optOut = entry.optOut
  const optOutObject = Boolean(optOut) && typeof optOut === 'object' && !Array.isArray(optOut)
  const valid =
    optOutObject &&
    // Strip mode judges only the known opt-out shape; a key a newer binary
    // added beside `reason` is dropped like any other unknown key.
    (mode === 'strip' ||
      Object.keys(optOut as Record<string, unknown>).every((key) => key === 'reason')) &&
    typeof (optOut as Record<string, unknown>).reason === 'string' &&
    Boolean((optOut as { reason: string }).reason.trim())
  if (!valid) {
    issues.push(
      mechanicalCheckIssue(identifier, 'optOut must contain only a non-empty reason', 'optOut'),
    )
  }
  return issues
}

function scalarOverrideIssues(
  identifier: string,
  entry: Record<string, unknown>,
  category: MechanicalCheckCategory,
): MechanicalCheckValidationIssue[] {
  const issues: MechanicalCheckValidationIssue[] = []
  for (const key of ['tool', 'note'] as const) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') {
      issues.push(mechanicalCheckIssue(identifier, `${key} must be a string`, key))
    }
  }
  if (entry.blocking !== undefined && typeof entry.blocking !== 'boolean') {
    issues.push(mechanicalCheckIssue(identifier, 'blocking must be a boolean', 'blocking'))
  }
  if (
    entry.limit !== undefined &&
    (typeof entry.limit !== 'number' || !Number.isInteger(entry.limit) || entry.limit <= 0)
  ) {
    issues.push(mechanicalCheckIssue(identifier, 'limit must be a positive integer', 'limit'))
  } else if (entry.limit !== undefined && !category.allowsLimit) {
    issues.push(
      mechanicalCheckIssue(
        identifier,
        `${identifier} has no limit; remove the limit field`,
        'limit',
      ),
    )
  }
  return issues
}

function pointIssues(
  identifier: string,
  value: unknown,
  category: MechanicalCheckCategory,
): MechanicalCheckValidationIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0) {
    return [
      mechanicalCheckIssue(
        identifier,
        `points must be a non-empty array of ${ENFORCEMENT_POINTS.join(', ')}`,
        'points',
      ),
    ]
  }
  const issues: MechanicalCheckValidationIssue[] = []
  if (
    value.some((point) => typeof point !== 'string' || !ENFORCEMENT_POINTS.includes(point as never))
  ) {
    issues.push(
      mechanicalCheckIssue(
        identifier,
        `points entries must be ${ENFORCEMENT_POINTS.join(', ')}`,
        'points',
      ),
    )
  }
  if (new Set(value).size !== value.length) {
    issues.push(mechanicalCheckIssue(identifier, 'points must not contain duplicates', 'points'))
  }
  const invalidProjectPoint =
    category.scope === 'project' &&
    value.some((point) => point === 'write' || (point === 'commit' && !category.allowsCommit))
  if (invalidProjectPoint) {
    issues.push(
      mechanicalCheckIssue(
        identifier,
        category.allowsCommit
          ? 'project-scope points cannot include write'
          : 'project-scope points cannot include write or commit',
        'points',
      ),
    )
  }
  return issues
}

/**
 * The refusal about a category or an entry field this binary does not know
 * depends on WHO is reading: a register write refuses one, because that is how
 * a typo in a declaration is caught, and a register read drops it, because a
 * newer binary may have written a category this one has never heard of and
 * refusing there takes the whole project out of the register. The mode is
 * spelled out here rather than shared with the register's own settings mode,
 * which imports this grammar and so cannot be imported back without a cycle.
 * Checks on a category and a field this binary knows are the same in both.
 */
export function mechanicalCheckEntryIssues(
  identifier: string,
  raw: unknown,
  mode: 'strict' | 'strip',
): MechanicalCheckValidationIssue[] {
  const category = MECHANICAL_CHECK_CATEGORIES.get(identifier)
  if (!category) {
    return mode === 'strict'
      ? [
          mechanicalCheckIssue(
            identifier,
            `unknown category; choose one of: ${MECHANICAL_CHECK_CATALOGUE.map(({ id }) => id).join(', ')}`,
          ),
        ]
      : []
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [mechanicalCheckIssue(identifier, 'entry must be an override or an opt-out object')]
  }
  const entry = raw as Record<string, unknown>
  const keys = Object.keys(entry)
  if (Object.hasOwn(entry, 'optOut')) return optOutIssues(identifier, entry, mode)
  if (keys.length === 0) {
    return [
      mechanicalCheckIssue(
        identifier,
        `empty override; set at least one of ${MECHANICAL_CHECK_OVERRIDE_FIELDS.join(', ')}`,
      ),
    ]
  }
  const unknown =
    mode === 'strict'
      ? keys.filter((key) => !MECHANICAL_CHECK_OVERRIDE_FIELDS.includes(key as never))
      : []
  return [
    ...(unknown.length
      ? [mechanicalCheckIssue(identifier, `entry has unknown fields: ${unknown.sort().join(', ')}`)]
      : []),
    ...scalarOverrideIssues(identifier, entry, category),
    ...pointIssues(identifier, entry.points, category),
  ]
}
