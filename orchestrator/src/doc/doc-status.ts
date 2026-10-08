/** Decides local document lifecycle metadata. Must not know storage, transport, or presentation. */
import { DOC_STATUSES, type DocStatus } from '../../../shared/docs.ts'
import type { Doc } from './doc-read-store.ts'

export type DocLifecycleInput = {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
  status?: DocStatus
  replacementSlug?: string | null
}

function replacementFor(input: DocLifecycleInput, prior: Doc | null): string | null {
  if (input.scope === 'resume') return null
  if (input.replacementSlug !== undefined) return input.replacementSlug
  if (input.status !== undefined && input.status !== 'superseded') return null
  return prior?.replacement_slug ?? null
}

export function docLifecycle(
  input: DocLifecycleInput,
  prior: Doc | null,
  replacementExists: (slug: string) => boolean,
): { status: DocStatus; replacementSlug: string | null } {
  const status = input.scope === 'resume' ? 'current' : (input.status ?? prior?.status ?? 'current')
  if (!DOC_STATUSES.includes(status)) {
    throw new Error(`unknown doc status "${status}"; valid statuses: ${DOC_STATUSES.join(', ')}`)
  }
  const replacementSlug = replacementFor(input, prior)
  const address = `--scope ${input.scope}${input.subject ? ` --subject ${input.subject}` : ''}`
  if (status !== 'superseded' && replacementSlug !== null) {
    throw new Error(
      `replacement is permitted only for superseded documents; cleared by: orch doc status ${input.slug} ${address} --status ${status} --reason TEXT`,
    )
  }
  if (status !== 'superseded') return { status, replacementSlug }
  if (!replacementSlug) {
    throw new Error(
      `superseded document requires a replacement slug; cleared by: orch doc status ${input.slug} ${address} --status superseded --replacement SLUG --reason TEXT`,
    )
  }
  if (replacementSlug === input.slug) {
    throw new Error(
      'document cannot replace itself; cleared by: name another document with --replacement',
    )
  }
  if (!replacementExists(replacementSlug)) {
    throw new Error(
      `replacement document "${replacementSlug}" does not exist in the same scope and subject; cleared by: orch doc set ${replacementSlug} ${address} --title TITLE --reason TEXT`,
    )
  }
  return { status, replacementSlug }
}
