// concern: document-tree-rules
/** Pure document audience and tree policy. Knows no store, transport, or clock. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DocAudiences } from '../../../shared/docs.ts'

export type TreeWriteInput = {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
  audiences?: DocAudiences
  parentSlug?: string | null
  position?: number
  featured?: boolean
}

export type TreeWritePrior = {
  audiences: DocAudiences
  parent_slug: string | null
  position: number
  featured: boolean
}

export type TreeWriteFields = {
  audiences: DocAudiences
  parentId: string | null
  parentSlug: string | null
  position: number
  featured: boolean
}

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
    )}; cleared by: re-parent each child with ${PLATFORM_SLUG} doc set <child> --parent <slug> (or --no-parent)`
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
  const set = `${PLATFORM_SLUG} doc set ${input.slug} --scope ${input.scope}${input.subject ? ` --subject ${input.subject}` : ''}`
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
      )}; cleared by: re-parent each child with ${PLATFORM_SLUG} doc set <child> --parent <slug> (or --no-parent), or remove the children first`
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

export function deriveDocumentTreeWriteFields(
  input: TreeWriteInput,
  prior: TreeWritePrior | null,
  facts: {
    parent: (DocumentTreeNode & { record_id: string }) | null
    children: Array<Pick<DocumentTreeNode, 'slug'>>
    ancestorSlugs: string[]
  },
): TreeWriteFields {
  const audiences = input.audiences ?? prior?.audiences ?? ['technical']
  if (input.position !== undefined && !Number.isInteger(input.position)) {
    throw new Error('--position must be an integer')
  }
  const requestedParentSlug = input.parentSlug
  const parentSlug =
    requestedParentSlug === undefined ? (prior?.parent_slug ?? null) : requestedParentSlug
  const refusal = documentTreeWriteRefusal({
    slug: input.slug,
    scope: input.scope,
    subject: input.subject,
    owner: input.owner ?? null,
    audiences,
    parent: facts.parent,
    requestedParentSlug,
    ancestorSlugs: facts.ancestorSlugs,
    children: facts.children,
  })
  if (refusal) throw new Error(refusal)
  return {
    audiences,
    parentId: facts.parent?.record_id ?? null,
    parentSlug,
    position: input.position ?? prior?.position ?? 0,
    featured: input.featured ?? prior?.featured ?? false,
  }
}
