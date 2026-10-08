/** Pure document lifecycle policy. Knows no store, transport, row type, or error class. */
import { DOC_STATUSES, type DocStatus } from '../../../shared/docs.ts'

export type DocumentLifecycleWrite = {
  scope: string
  subject: string | null
  slug: string
  requestedStatus?: DocStatus
  requestedReplacementSlug?: string | null
  priorStatus?: DocStatus
  priorReplacementSlug?: string | null
  replacementExists: boolean
}

export type DocumentLifecycleDecision =
  | { status: DocStatus; replacementSlug: string | null; refusal: null }
  | { status: null; replacementSlug: null; refusal: string }

export function resolvedReplacementSlug(
  input: Omit<DocumentLifecycleWrite, 'replacementExists'>,
): string | null {
  if (input.scope === 'resume') return null
  if (input.requestedReplacementSlug !== undefined) return input.requestedReplacementSlug
  if (input.requestedStatus !== undefined && input.requestedStatus !== 'superseded') return null
  return input.priorReplacementSlug ?? null
}

export function documentLifecycleDecision(
  input: DocumentLifecycleWrite,
): DocumentLifecycleDecision {
  const status =
    input.scope === 'resume' ? 'current' : (input.requestedStatus ?? input.priorStatus ?? 'current')
  const address = `--scope ${input.scope}${input.subject ? ` --subject ${input.subject}` : ''}`
  const statusCommand = `orch doc status ${input.slug} ${address}`
  if (!DOC_STATUSES.includes(status)) {
    return {
      status: null,
      replacementSlug: null,
      refusal: `unknown doc status "${status}"; valid statuses: ${DOC_STATUSES.join(', ')}`,
    }
  }
  const replacementSlug = resolvedReplacementSlug(input)
  if (status !== 'superseded' && replacementSlug !== null) {
    return {
      status: null,
      replacementSlug: null,
      refusal: `replacement is permitted only for superseded documents; cleared by: ${statusCommand} --status ${status} --reason TEXT`,
    }
  }
  if (status !== 'superseded') return { status, replacementSlug, refusal: null }
  if (!replacementSlug) {
    return {
      status: null,
      replacementSlug: null,
      refusal: `superseded document requires a replacement slug; cleared by: ${statusCommand} --status superseded --replacement SLUG --reason TEXT`,
    }
  }
  if (replacementSlug === input.slug) {
    return {
      status: null,
      replacementSlug: null,
      refusal: `document cannot replace itself; cleared by: ${statusCommand} --status superseded --replacement OTHER_SLUG --reason TEXT`,
    }
  }
  if (!input.replacementExists) {
    return {
      status: null,
      replacementSlug: null,
      refusal: `replacement document "${replacementSlug}" does not exist in the same scope and subject; cleared by: orch doc set ${replacementSlug} ${address} --title TITLE --reason TEXT`,
    }
  }
  return { status, replacementSlug, refusal: null }
}
