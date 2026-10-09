// concern: document-tree-rules
/** Pure document audience and tree policy. Knows no store, transport, or clock. */
import type { DocAudiences } from '../../../shared/docs.ts'

type DocumentTreeNode = {
  slug: string
  scope: string
  subject: string | null
  owner: string | null
  audiences: DocAudiences
  deleted?: boolean
}

export type DocumentTreeWrite = DocumentTreeNode & {
  parent: DocumentTreeNode | null
  requestedParentSlug?: string | null
  ancestorSlugs: string[]
  children: Array<Pick<DocumentTreeNode, 'slug'>>
  removing?: boolean
  spaceMatches?: boolean
}

function canonTreeRefusal(input: DocumentTreeWrite, address: string, set: string): string | null {
  if (
    input.scope === 'canon' &&
    (input.parent !== null ||
      (input.requestedParentSlug !== undefined && input.requestedParentSlug !== null))
  ) {
    return `refusing ${address}: canon documents cannot have a parent; cleared by: re-run ${set} --no-parent`
  }
  if (input.parent?.scope === 'canon') {
    return `refusing ${address}: canon document "${input.parent.slug}" cannot be used as a parent; cleared by: re-run ${set} --no-parent or choose a non-canon parent`
  }
  if (input.scope !== 'canon' || !input.children.length) return null
  return `refusing ${address}: canon documents cannot have children ${input.children
    .map((child) => child.slug)
    .sort()
    .join(
      ', ',
    )}; cleared by: re-parent each child with orch doc set <child> --parent <slug> (or --no-parent)`
}

function audienceScopeRefusal(
  input: DocumentTreeWrite,
  address: string,
  set: string,
): string | null {
  return input.audiences.some((audience) => audience === 'internal' || audience === 'customer') &&
    input.scope !== 'project' &&
    input.scope !== 'global'
    ? `refusing ${address}: internal and customer audiences are allowed only for project and global documents; cleared by: re-run ${set} --audience technical`
    : null
}

export function documentTreeWriteRefusal(input: DocumentTreeWrite): string | null {
  const address = `${input.scope}/${input.subject ?? '_'}/${input.slug}`
  const set = `orch doc set ${input.slug} --scope ${input.scope}${input.subject ? ` --subject ${input.subject}` : ''}`
  const audienceRefusal = audienceScopeRefusal(input, address, set)
  if (audienceRefusal) return audienceRefusal
  const canonRefusal = canonTreeRefusal(input, address, set)
  if (canonRefusal) return canonRefusal
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
  if (input.parent.slug === input.slug || input.ancestorSlugs.includes(input.slug)) {
    return `refusing ${address}: parent "${input.parent.slug}" creates a document cycle; cleared by: re-run ${set} --no-parent or choose a parent outside this document's descendants`
  }
  return null
}
