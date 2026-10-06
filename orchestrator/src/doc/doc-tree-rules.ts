// concern: document-tree-rules
/** Pure document audience and tree policy. Knows no store, transport, or clock. */
import type { DocAudience } from '../../../shared/docs.ts'

export type DocumentTreeNode = {
  slug: string
  scope: string
  subject: string | null
  owner: string | null
  audience: DocAudience
  deleted?: boolean
}

export type DocumentTreeWrite = DocumentTreeNode & {
  priorAudience?: DocAudience
  parent: DocumentTreeNode | null
  requestedParentSlug?: string | null
  ancestorSlugs: string[]
  children: Array<Pick<DocumentTreeNode, 'slug' | 'audience'>>
  removing?: boolean
  spaceMatches?: boolean
}

export function documentTreeWriteRefusal(input: DocumentTreeWrite): string | null {
  const address = `${input.scope}/${input.subject ?? '_'}/${input.slug}`
  const set = `orch doc set ${input.slug} --scope ${input.scope}${input.subject ? ` --subject ${input.subject}` : ''}`
  if (input.audience === 'user' && input.scope !== 'project' && input.scope !== 'global') {
    return `refusing ${address}: user audience is allowed only for project and global documents; cleared by: re-run ${set} --audience technical`
  }
  if (input.removing && input.children.length) {
    return `refusing to remove ${address}: document has children ${input.children
      .map((child) => child.slug)
      .sort()
      .join(
        ', ',
      )}; cleared by: re-parent each child with orch doc set <child> --parent <slug> (or --no-parent), or remove the children first`
  }
  if (
    input.requestedParentSlug !== undefined &&
    input.requestedParentSlug !== null &&
    !input.parent
  ) {
    return `refusing ${address}: parent "${input.requestedParentSlug}" does not exist; cleared by: create that document or re-run ${set} --no-parent`
  }
  if (
    input.priorAudience !== undefined &&
    input.priorAudience !== input.audience &&
    input.children.some((child) => child.audience !== input.audience)
  ) {
    const children = input.children
      .filter((child) => child.audience !== input.audience)
      .map((child) => child.slug)
      .sort()
    return `refusing ${address}: audience change would differ from children ${children.join(', ')}; cleared by: re-parent those children or change their audience before re-running ${set} --audience ${input.audience}`
  }
  if (!input.parent) return null
  if (input.parent.deleted) {
    return `refusing ${address}: parent "${input.parent.slug}" is deleted; cleared by: restore the parent or re-run ${set} --no-parent`
  }
  if (
    input.parent.scope !== input.scope ||
    input.parent.subject !== input.subject ||
    input.parent.owner !== input.owner ||
    input.spaceMatches === false
  ) {
    return `refusing ${address}: parent "${input.parent.slug}" must share the child's scope, subject, owner${input.spaceMatches === false ? ', and space' : ''}; cleared by: choose a parent at the same address or re-run ${set} --no-parent`
  }
  if (input.parent.audience !== input.audience) {
    return `refusing ${address}: child audience ${input.audience} must equal parent "${input.parent.slug}" audience ${input.parent.audience}; cleared by: set both documents to the same audience or re-run ${set} --no-parent`
  }
  if (input.parent.slug === input.slug || input.ancestorSlugs.includes(input.slug)) {
    return `refusing ${address}: parent "${input.parent.slug}" creates a document cycle; cleared by: re-run ${set} --no-parent or choose a parent outside this document's descendants`
  }
  return null
}
