// concern: enforcement-resolution
/** Resolves declarations and retained legacy settings against the enforcement catalogue. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ProjectSettings } from '../project/project-settings.ts'
import {
  type EnforcementPoint,
  type EnforcementScope,
  type EnforcementToolchain,
  MECHANICAL_CHECK_CATALOGUE,
  type MechanicalCheckCategory,
  type MechanicalCheckDefault,
  toolchainForStack,
} from './enforcement-catalogue.ts'
import type {
  MechanicalCheckEntry,
  MechanicalCheckOverride,
} from './mechanical-check-declaration.ts'

type EnforcementSource = 'default' | 'stack' | 'own' | 'opted-out' | 'uncovered' | 'not-applicable'

export type ResolvedMechanicalCheck = {
  category: string
  title: string
  scope: EnforcementScope
  enforced: boolean
  tool: string | null
  points: EnforcementPoint[]
  blocking: boolean
  limit: number | null
  source: EnforcementSource
  note: string | null
  reason: string | null
}

export type MechanicallyEnforcedCheck = Pick<
  ResolvedMechanicalCheck,
  'category' | 'title' | 'tool'
> & { tool: string }

type EffectiveOverride = MechanicalCheckOverride
type EnforcementProjectSettings = Pick<
  ProjectSettings,
  'mechanicalChecks' | 'checks' | 'testSubstance'
>

const defaultPoints = (scope: EnforcementScope): EnforcementPoint[] =>
  scope === 'file' ? ['commit', 'gate'] : ['gate']

function joinedNote(...parts: Array<string | null | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part))
  return present.length ? present.join('; ') : undefined
}

function legacyOverride(
  category: string,
  settings: EnforcementProjectSettings,
): EffectiveOverride | undefined {
  const checks = settings.checks
  const commentTaskKeys = checks?.commentTaskKeys === true
  const commentHistory = Boolean(checks?.commentHistory)
  if (category === 'spelling' && checks?.spelling) {
    return { tool: `${PLATFORM_SLUG} gate check spelling` }
  }
  if (category === 'attribution-markers' && checks?.attribution) return {}
  if (category === 'comment-hygiene' && (commentTaskKeys || commentHistory)) {
    const enabled = [
      commentTaskKeys ? 'commentTaskKeys' : null,
      commentHistory ? 'commentHistory' : null,
    ].filter(Boolean)
    return {
      tool: `${PLATFORM_SLUG} gate check comments`,
      note: `settings.checks: ${enabled.join(', ')}`,
    }
  }
  return undefined
}

function effectiveEntry(
  category: string,
  settings: EnforcementProjectSettings,
): MechanicalCheckEntry | EffectiveOverride | undefined {
  const declared = settings.mechanicalChecks?.[category]
  if (declared && 'optOut' in declared) return declared
  const legacy = legacyOverride(category, settings)
  if (!declared) return legacy
  return {
    ...legacy,
    ...declared,
    note: joinedNote(legacy?.note, declared.note),
  }
}

function stackDefault(
  category: MechanicalCheckCategory,
  toolchain: EnforcementToolchain,
): MechanicalCheckDefault | 'not-applicable' | undefined {
  if (toolchain === 'unknown') return undefined
  return category[toolchain]
}

function resolvedCategory(
  category: MechanicalCheckCategory,
  toolchain: EnforcementToolchain,
  entry: MechanicalCheckEntry | EffectiveOverride | undefined,
): ResolvedMechanicalCheck {
  if (entry && 'optOut' in entry) {
    return {
      category: category.id,
      title: category.title,
      scope: category.scope,
      enforced: false,
      tool: null,
      points: [],
      blocking: false,
      limit: null,
      source: 'opted-out',
      note: null,
      reason: entry.optOut.reason,
    }
  }

  const selectedStackDefault = stackDefault(category, toolchain)
  const notApplicable = selectedStackDefault === 'not-applicable'
  const base =
    selectedStackDefault && selectedStackDefault !== 'not-applicable'
      ? selectedStackDefault
      : category.general
  const override = entry as EffectiveOverride | undefined
  const tool = override?.tool ?? base?.tool ?? null
  const note = override?.note ?? null
  if (!override && notApplicable) {
    return {
      category: category.id,
      title: category.title,
      scope: category.scope,
      enforced: false,
      tool: null,
      points: [],
      blocking: false,
      limit: null,
      source: 'not-applicable',
      note,
      reason: null,
    }
  }
  const values = {
    points: [...(override?.points ?? base?.points ?? defaultPoints(category.scope))],
    blocking: override?.blocking ?? base?.blocking ?? true,
    limit: override?.limit ?? base?.limit ?? null,
  }
  if (!tool) {
    return {
      category: category.id,
      title: category.title,
      scope: category.scope,
      enforced: false,
      tool: null,
      points: [],
      blocking: false,
      limit: null,
      source: 'uncovered',
      note,
      reason: null,
    }
  }
  return {
    category: category.id,
    title: category.title,
    scope: category.scope,
    enforced: Boolean(override) || base?.platform === true,
    tool,
    ...values,
    source: override ? 'own' : selectedStackDefault ? 'stack' : 'default',
    note,
    reason: null,
  }
}

function phpPolicyNote(settings: EnforcementProjectSettings): string | null {
  const rules = settings.testSubstance?.phpPolicyRules
  return rules?.length ? `PHP policy rules: ${rules.join(', ')}` : null
}

export function resolveMechanicalChecks(input: {
  stack: string | null
  settings: EnforcementProjectSettings
}): ResolvedMechanicalCheck[] {
  const toolchain = toolchainForStack(input.stack)
  return MECHANICAL_CHECK_CATALOGUE.map((category) => {
    const row = resolvedCategory(category, toolchain, effectiveEntry(category.id, input.settings))
    if (category.id !== 'test-substance') return row
    return { ...row, note: joinedNote(row.note, phpPolicyNote(input.settings)) ?? null }
  })
}

/** Categories a blocking commit or gate tool already refuses for this project. */
export function mechanicallyEnforcedChecks(
  rows: readonly ResolvedMechanicalCheck[],
): MechanicallyEnforcedCheck[] {
  return rows.flatMap((row) =>
    row.enforced &&
    row.blocking &&
    row.tool !== null &&
    row.points.some((point) => point === 'commit' || point === 'gate')
      ? [{ category: row.category, title: row.title, tool: row.tool }]
      : [],
  )
}
