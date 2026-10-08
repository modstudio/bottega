/** Decides hosted document lifecycle metadata. Must not know document bodies or presentation. */
import { DOC_STATUSES, type DocStatus } from '../../../shared/docs.ts'
import { RecordDocError } from './record-doc-errors.ts'

type StatusInput = {
  scope: string
  slug: string
  status?: DocStatus
  replacementSlug?: string | null
}

type PriorStatus = { status?: unknown; replacement_slug?: unknown } | undefined

function replacementFor(input: StatusInput, prior: PriorStatus): string | null {
  if (input.scope === 'resume') return null
  if (input.replacementSlug !== undefined) return input.replacementSlug
  if (input.status !== undefined && input.status !== 'superseded') return null
  return prior?.replacement_slug == null ? null : String(prior.replacement_slug)
}

export async function recordDocLifecycle(
  input: StatusInput,
  prior: PriorStatus,
  replacementExists: (slug: string) => Promise<boolean>,
): Promise<{ status: DocStatus; replacementSlug: string | null }> {
  const status =
    input.scope === 'resume'
      ? 'current'
      : ((input.status ?? (prior?.status == null ? 'current' : String(prior.status))) as DocStatus)
  if (!DOC_STATUSES.includes(status)) throw new RecordDocError(`unknown doc status "${status}"`)
  const replacementSlug = replacementFor(input, prior)
  if (status !== 'superseded' && replacementSlug !== null) {
    throw new RecordDocError(
      'replacement is permitted only for superseded documents; cleared by: retry the write without replacementSlug',
    )
  }
  if (status !== 'superseded') return { status, replacementSlug }
  if (!replacementSlug) {
    throw new RecordDocError(
      'superseded document requires a replacement slug; cleared by: retry with replacementSlug',
    )
  }
  if (replacementSlug === input.slug) {
    throw new RecordDocError(
      'document cannot replace itself; cleared by: name another document as replacement',
    )
  }
  if (!(await replacementExists(replacementSlug))) {
    throw new RecordDocError(
      `replacement document "${replacementSlug}" does not exist in the same scope and subject; cleared by: create that document, then retry the write`,
    )
  }
  return { status, replacementSlug }
}
