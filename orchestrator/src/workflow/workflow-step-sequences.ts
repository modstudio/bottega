// concern: workflows
/** Owns named workflow-step sequences and their flat expansion. */

import type { CatalogueSequence, CatalogueStep } from './step-catalogue-definition.ts'
import type {
  WorkflowMode,
  WorkflowModeStep,
  WorkflowStepCondition,
} from './workflow-definition.ts'

export type ExpandedWorkflowStep = { slug: string; when?: WorkflowStepCondition }
export type WorkflowStepInspection = {
  expanded: string[]
  detailed: ExpandedWorkflowStep[]
  missingSequences: string[]
  missingSteps: string[]
  duplicateSteps: string[]
  invalidOmissions: { sequence: string; step: string }[]
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function isSequenceReference(
  value: unknown,
): value is { sequence: string; omit?: string[] } {
  if (!object(value) || typeof value.sequence !== 'string') return false
  const keys = Object.keys(value)
  return keys.every((key) => key === 'sequence' || key === 'omit') && keys.includes('sequence')
}

export function isConditionalStep(
  value: unknown,
): value is { step: string; when: WorkflowStepCondition } {
  return (
    object(value) &&
    Object.keys(value).length === 2 &&
    typeof value.step === 'string' &&
    object(value.when) &&
    Object.keys(value.when).length === 2 &&
    typeof value.when.step === 'string' &&
    Array.isArray(value.when.outcome)
  )
}

function expandSequenceReference(
  entry: { sequence: string; omit?: string[] },
  bySlug: ReadonlyMap<string, string[]>,
): {
  steps: ExpandedWorkflowStep[]
  missing?: string
  invalidOmissions: { sequence: string; step: string }[]
} {
  const members = bySlug.get(entry.sequence)
  if (!members) return { steps: [], missing: entry.sequence, invalidOmissions: [] }
  const omitted = new Set(entry.omit ?? [])
  return {
    steps: members.filter((step) => !omitted.has(step)).map((slug) => ({ slug })),
    invalidOmissions: [...omitted]
      .filter((step) => !members.includes(step))
      .map((step) => ({ sequence: entry.sequence, step })),
  }
}

function expandEntries(
  entries: readonly WorkflowModeStep[],
  sequences: readonly CatalogueSequence[],
) {
  const bySlug = new Map(sequences.map((sequence) => [sequence.slug, sequence.steps]))
  const detailed: ExpandedWorkflowStep[] = []
  const missingSequences: string[] = []
  const invalidOmissions: { sequence: string; step: string }[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') detailed.push({ slug: entry })
    else if (isConditionalStep(entry)) detailed.push({ slug: entry.step, when: entry.when })
    else {
      const expansion = expandSequenceReference(entry, bySlug)
      detailed.push(...expansion.steps)
      invalidOmissions.push(...expansion.invalidOmissions)
      if (expansion.missing) missingSequences.push(expansion.missing)
    }
  }
  return { detailed, missingSequences: [...new Set(missingSequences)], invalidOmissions }
}

export function expandWorkflowModeSteps(
  entries: readonly WorkflowModeStep[],
  sequences: readonly CatalogueSequence[],
): ExpandedWorkflowStep[] {
  const result = expandEntries(entries, sequences)
  if (result.missingSequences.length)
    throw new Error(
      `sequence "${result.missingSequences[0]}" is absent from the catalogue; add and promote that sequence, or edit the workflow mode to remove the reference`,
    )
  if (result.invalidOmissions.length) {
    const invalid = result.invalidOmissions[0]!
    throw new Error(
      `sequence "${invalid.sequence}" cannot omit non-member step "${invalid.step}"; remove it from omit`,
    )
  }
  return result.detailed
}

export function expandWorkflowSteps(
  entries: readonly WorkflowModeStep[],
  sequences: readonly CatalogueSequence[],
): string[] {
  return expandWorkflowModeSteps(entries, sequences).map(({ slug }) => slug)
}

export type ExpandedMode = {
  mode: WorkflowMode
  steps: ExpandedWorkflowStep[]
}

export function workflowStepSuccessor(
  stepSlug: string,
  catalogueSteps: readonly CatalogueStep[],
  selectedMode: ExpandedMode | undefined,
  containingModes: readonly ExpandedMode[],
) {
  const successor = ({ steps }: ExpandedMode) => {
    const index = steps.findIndex((entry) => entry.slug === stepSlug)
    if (index === steps.length - 1) return null
    const nextEntry = steps[index + 1]!
    const next = catalogueSteps.find((item) => item.slug === nextEntry.slug)!
    return {
      n: index + 2,
      slug: next.slug,
      title: next.title,
      ...(nextEntry.when ? { when: nextEntry.when } : {}),
    }
  }
  const successors = (selectedMode ? [selectedMode] : containingModes).map(successor)
  if (selectedMode) return successors[0]
  return successors.every(
    (candidate) => JSON.stringify(candidate) === JSON.stringify(successors[0]),
  )
    ? successors[0]
    : undefined
}

export function inspectWorkflowSteps(
  entries: readonly WorkflowModeStep[],
  sequences: readonly CatalogueSequence[],
  stepSlugs: ReadonlySet<string>,
): WorkflowStepInspection {
  const { detailed, missingSequences, invalidOmissions } = expandEntries(entries, sequences)
  const expanded = detailed.map(({ slug }) => slug)
  return {
    expanded,
    detailed,
    missingSequences,
    missingSteps: [...new Set(expanded.filter((step) => !stepSlugs.has(step)))],
    duplicateSteps: [
      ...new Set(expanded.filter((step, index) => expanded.indexOf(step) !== index)),
    ],
    invalidOmissions,
  }
}

export function workflowModeStepError(value: unknown): string | null {
  if (typeof value === 'string') return null
  if (isSequenceReference(value)) {
    if (value.omit === undefined) return null
    if (!Array.isArray(value.omit) || value.omit.length === 0)
      return `step entry ${JSON.stringify(value)} omit must be a non-empty string array`
    if (value.omit.some((step) => typeof step !== 'string'))
      return `step entry ${JSON.stringify(value)} omit must contain only step slugs`
    return null
  }
  if (isConditionalStep(value)) {
    if (value.when.outcome.length === 0)
      return `step entry ${JSON.stringify(value)} when.outcome must be non-empty`
    if (value.when.outcome.some((outcome) => typeof outcome !== 'string' || !SLUG.test(outcome)))
      return `step entry ${JSON.stringify(value)} when.outcome must contain only outcome slugs`
    return null
  }
  return `step entry ${JSON.stringify(value)} must be a step slug or exactly {"sequence":"<slug>","omit"?:[...]}, or exactly {"step":"<slug>","when":{"step":"<slug>","outcome":[...]}}; edit the workflow mode to use one of those forms`
}

function workflowReentryErrors(
  mode: string,
  detailed: readonly ExpandedWorkflowStep[],
  steps: readonly CatalogueStep[],
): string[] {
  const bySlug = new Map(steps.map((step) => [step.slug, step]))
  return detailed.flatMap((entry, index) => {
    const reenter = bySlug.get(entry.slug)?.reenter
    if (!reenter) return []
    const prior = detailed.findIndex(({ slug }) => slug === reenter.to)
    if (prior < 0 || prior >= index)
      return [
        `mode "${mode}" step "${entry.slug}" reentry to "${reenter.to}" must be an earlier step in the expanded mode`,
      ]
    return []
  })
}

export function workflowConditionErrors(
  mode: string,
  detailed: readonly ExpandedWorkflowStep[],
  steps: readonly CatalogueStep[],
): string[] {
  const bySlug = new Map(steps.map((step) => [step.slug, step]))
  const whenErrors = detailed.flatMap((entry, index) => {
    if (!entry.when) return []
    const prior = detailed.findIndex(({ slug }) => slug === entry.when!.step)
    if (prior < 0 || prior >= index)
      return [
        `mode "${mode}" step "${entry.slug}" condition step "${entry.when.step}" must be an earlier step in the expanded mode`,
      ]
    const declared = new Set(bySlug.get(entry.when.step)?.outcomes ?? [])
    const missing = entry.when.outcome.filter((outcome) => !declared.has(outcome))
    return missing.length
      ? [
          `mode "${mode}" step "${entry.slug}" condition names undeclared outcome ${missing.map((outcome) => `"${outcome}"`).join(', ')} on step "${entry.when.step}"`,
        ]
      : []
  })
  return [...whenErrors, ...workflowReentryErrors(mode, detailed, steps)]
}

export function validateCatalogueSequences(
  value: unknown,
  stepSlugs: ReadonlySet<string>,
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value))
    return ['sequences must be an array; edit the catalogue to use a list of named sequences']
  const errors: string[] = []
  const sequenceSlugs = new Set(
    value.flatMap((item) => (object(item) && typeof item.slug === 'string' ? [item.slug] : [])),
  )
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!object(item)) {
      errors.push(`sequence ${index + 1} must be an object; edit the catalogue sequence`)
      continue
    }
    const slug = validateSequenceIdentity(item, seen, stepSlugs, errors)
    if (!Array.isArray(item.steps) || item.steps.length === 0) {
      errors.push(`sequence "${slug}" must contain at least one step; add a step slug`)
      continue
    }
    for (const member of item.steps)
      validateSequenceMember(slug, member, sequenceSlugs, stepSlugs, errors)
  }
  return errors
}

function validateSequenceIdentity(
  item: Record<string, unknown>,
  seen: Set<string>,
  stepSlugs: ReadonlySet<string>,
  errors: string[],
): string {
  const slug = typeof item.slug === 'string' ? item.slug : ''
  if (!SLUG.test(slug))
    errors.push(`sequence slug "${slug}" is not well-formed; edit it to a valid slug`)
  if (seen.has(slug))
    errors.push(`duplicate sequence slug "${slug}"; rename or remove one sequence`)
  seen.add(slug)
  if (stepSlugs.has(slug))
    errors.push(
      `slug "${slug}" names both a step and a sequence; rename either the step or the sequence`,
    )
  if (typeof item.title !== 'string' || !item.title.trim())
    errors.push(`sequence "${slug}" title must be non-empty; edit the sequence title`)
  return slug
}

function validateSequenceMember(
  slug: string,
  member: unknown,
  sequenceSlugs: ReadonlySet<string>,
  stepSlugs: ReadonlySet<string>,
  errors: string[],
): void {
  if (typeof member !== 'string')
    errors.push(
      `sequence "${slug}" entries must be step slugs; edit the sequence to remove ${JSON.stringify(member)}`,
    )
  else if (sequenceSlugs.has(member))
    errors.push(
      `sequence "${slug}" names sequence "${member}"; replace it with that sequence's step slugs`,
    )
  else if (!stepSlugs.has(member))
    errors.push(
      `sequence "${slug}" references missing step "${member}"; add that step or edit the sequence`,
    )
}
