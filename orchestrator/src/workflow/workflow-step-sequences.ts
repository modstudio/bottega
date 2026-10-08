// concern: workflows
/** Owns named workflow-step sequences and their flat expansion. */

import type { CatalogueSequence } from './step-catalogue-definition.ts'
import type { WorkflowModeStep } from './workflow-definition.ts'

export type WorkflowStepInspection = {
  expanded: string[]
  missingSequences: string[]
  missingSteps: string[]
  duplicateSteps: string[]
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function isSequenceReference(value: unknown): value is { sequence: string } {
  return object(value) && Object.keys(value).length === 1 && typeof value.sequence === 'string'
}

function expandEntries(
  entries: readonly WorkflowModeStep[],
  sequences: readonly CatalogueSequence[],
): { expanded: string[]; missingSequences: string[] } {
  const bySlug = new Map(sequences.map((sequence) => [sequence.slug, sequence.steps]))
  const expanded: string[] = []
  const missingSequences: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') expanded.push(entry)
    else {
      const steps = bySlug.get(entry.sequence)
      if (steps) expanded.push(...steps)
      else missingSequences.push(entry.sequence)
    }
  }
  return { expanded, missingSequences: [...new Set(missingSequences)] }
}

export function expandWorkflowSteps(
  entries: readonly WorkflowModeStep[],
  sequences: readonly CatalogueSequence[],
): string[] {
  const { expanded, missingSequences } = expandEntries(entries, sequences)
  if (missingSequences.length)
    throw new Error(
      `sequence "${missingSequences[0]}" is absent from the catalogue; add and promote that sequence, or edit the workflow mode to remove the reference`,
    )
  return expanded
}

export function inspectWorkflowSteps(
  entries: readonly WorkflowModeStep[],
  sequences: readonly CatalogueSequence[],
  stepSlugs: ReadonlySet<string>,
): WorkflowStepInspection {
  const { expanded, missingSequences } = expandEntries(entries, sequences)
  return {
    expanded,
    missingSequences,
    missingSteps: [...new Set(expanded.filter((step) => !stepSlugs.has(step)))],
    duplicateSteps: [
      ...new Set(expanded.filter((step, index) => expanded.indexOf(step) !== index)),
    ],
  }
}

export function workflowModeStepError(value: unknown): string | null {
  if (typeof value === 'string' || isSequenceReference(value)) return null
  return `step entry ${JSON.stringify(value)} must be a step slug or exactly {"sequence":"<slug>"}; edit the workflow mode to use one of those forms`
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
  if (typeof member !== 'string') {
    errors.push(
      `sequence "${slug}" entries must be step slugs; edit the sequence to remove ${JSON.stringify(member)}`,
    )
  } else if (sequenceSlugs.has(member)) {
    errors.push(
      `sequence "${slug}" names sequence "${member}"; replace it with that sequence's step slugs`,
    )
  } else if (!stepSlugs.has(member)) {
    errors.push(
      `sequence "${slug}" references missing step "${member}"; add that step or edit the sequence`,
    )
  }
}
