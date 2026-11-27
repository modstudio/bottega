// concern: document-rewrite-payload
/** Preserves every stored field shared by metadata-only document rewrites. */

import type { Doc } from './doc-authoritative-read.ts'

export function docRewritePayload(current: Doc) {
  return {
    scope: current.scope,
    subject: current.subject,
    owner: current.owner,
    slug: current.slug,
    title: current.title,
    body: current.body,
    delivery: current.delivery,
    audiences: current.audiences,
    parentSlug: current.parent_slug,
    position: current.position,
    featured: current.featured,
  }
}
