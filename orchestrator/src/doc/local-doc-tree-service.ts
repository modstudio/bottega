// concern: local-doc-tree-service
/** Applies document tree policy to local-store facts and maps local parents to hosted ids. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { decodeStoredDocAudiences } from './doc-audiences-codec.ts'
import type { Doc } from './doc-read-store.ts'
import {
  deriveDocumentTreeWriteFields,
  documentTreeWriteRefusal,
  type TreeWriteFields,
  type TreeWriteInput,
} from './doc-tree-rules.ts'

export type LocalDocTreeFields = TreeWriteFields

function treeDoc(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null,
): Doc | null {
  const row = db()
    .query(
      `SELECT d.*, p.slug AS parent_slug, NULL AS revision FROM doc d LEFT JOIN doc p ON p.record_id=d.parent_record_id WHERE d.scope=? AND d.subject IS ? AND d.owner IS ? AND d.slug=?`,
    )
    .get(scope, subject, owner, slug) as (Omit<Doc, 'audiences'> & { audiences: string }) | null
  return row ? { ...row, audiences: decodeStoredDocAudiences(row.audiences) } : null
}

export function localDocTreeFields(input: TreeWriteInput, prior: Doc | null): LocalDocTreeFields {
  const parentSlug =
    input.parentSlug === undefined ? (prior?.parent_slug ?? null) : input.parentSlug
  const parent = parentSlug
    ? treeDoc(input.scope, input.subject, parentSlug, input.owner ?? null)
    : null
  const children = prior
    ? (db()
        .query('SELECT slug FROM doc WHERE parent_record_id=? ORDER BY slug')
        .all(prior.record_id) as Array<{
        slug: string
      }>)
    : []
  const ancestorSlugs: string[] = []
  let ancestor = parent
  const seen = new Set<string>()
  while (ancestor && !seen.has(ancestor.record_id)) {
    seen.add(ancestor.record_id)
    ancestorSlugs.push(ancestor.slug)
    if (!ancestor.parent_record_id) {
      ancestor = null
      continue
    }
    const row = db()
      .query(
        `SELECT d.*, p.slug AS parent_slug, NULL AS revision FROM doc d LEFT JOIN doc p ON p.record_id=d.parent_record_id WHERE d.record_id=?`,
      )
      .get(ancestor.parent_record_id) as (Omit<Doc, 'audiences'> & { audiences: string }) | null
    ancestor = row ? { ...row, audiences: decodeStoredDocAudiences(row.audiences) } : null
  }
  return deriveDocumentTreeWriteFields(input, prior, {
    parent,
    ancestorSlugs,
    children,
  })
}

export function assertLocalDocRemovalAllowed(doc: Doc): void {
  const children = db()
    .query('SELECT slug FROM doc WHERE parent_record_id=? ORDER BY slug')
    .all(doc.record_id) as Array<{ slug: string }>
  const refusal = documentTreeWriteRefusal({
    ...doc,
    parent: null,
    ancestorSlugs: [],
    children,
    removing: true,
  })
  if (refusal) throw new Error(refusal)
}

export function localParentRecordId(doc: {
  scope: string
  subject: string | null
  owner: string | null
  parent_record_id: string | null
  parent_slug: string | null
}): string | null {
  if (doc.parent_record_id === null) return null
  const recordId = treeDoc(doc.scope, doc.subject, doc.parent_slug!, doc.owner)?.record_id
  if (!recordId) {
    throw new Error(
      `parent "${doc.parent_slug}" has no hosted record id; cleared by: run ${PLATFORM_SLUG} record push-docs before writing this document`,
    )
  }
  return recordId
}

export function localRestoredParentSlug(input: {
  scope: string
  subject: string | null
  slug: string
  parentId: string | null
}): string | null {
  if (input.parentId === null) return null
  const parent = db().query('SELECT slug FROM doc WHERE record_id=?').get(input.parentId) as {
    slug: string
  } | null
  if (!parent) {
    throw new Error(
      `refusing to restore ${input.scope}/${input.subject ?? '_'}/${input.slug}: revision parent ${input.parentId} no longer exists; cleared by: restore the parent first or run ${PLATFORM_SLUG} doc restore ${input.slug} with a revision recorded without a parent`,
    )
  }
  return parent.slug
}
