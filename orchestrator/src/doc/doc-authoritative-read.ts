// concern: authoritative-document-read
/** Routes operator document reads to their authoritative store. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { docBodyForAudience } from '../../../shared/doc-sections.ts'
import type { DocAudience } from '../../../shared/docs.ts'
import { projectAt } from '../project/projects.ts'
import { applyRecordReadAuthority } from '../record/record-read-authority.ts'
import { hostedDocClient } from './doc-hosted-client.ts'
import { type HostedDocRevision, hostedDocRevisionRead } from './doc-hosted-history.ts'
import { listDocMetadata as listLocalDocMetadata, listDocs as listLocalDocs } from './doc-list.ts'
import {
  type Doc,
  type DocListFilters,
  type DocMetadata,
  getDocForAudienceStore,
  getDocStore,
} from './doc-read-store.ts'
import { parseResumeFrontmatter, resumeAge } from './doc-resume-frontmatter.ts'
import { listStoredDocRevisions } from './doc-revision-store.ts'

type HostedRow = Record<string, unknown>

function docFromHosted(row: HostedRow): Doc {
  const body = String(row.body ?? '')
  return {
    record_id: String(row.id),
    scope: String(row.scope) as Doc['scope'],
    subject: row.subject == null ? null : String(row.subject),
    owner: row.owner == null ? null : String(row.owner),
    project_record_id: null,
    slug: String(row.slug),
    title: String(row.title),
    body,
    delivery: String(row.delivery) as Doc['delivery'],
    audiences: (row.audiences ?? ['technical']) as Doc['audiences'],
    featured: Boolean(row.featured),
    status: String(row.status ?? 'current') as Doc['status'],
    kind: String(row.kind ?? 'working') as Doc['kind'],
    form: (row.form ?? null) as Doc['form'],
    article_subject_id: (row.articleSubject as { id?: string } | null)?.id ?? null,
    articleSubject: (row.articleSubject ?? null) as Doc['articleSubject'],
    relatedSubjects: (row.relatedSubjects ?? []) as Doc['relatedSubjects'],
    sourceFiles: (row.sourceFiles ?? []) as string[],
    checkedAgainstCommit:
      row.checkedAgainstCommit == null ? null : String(row.checkedAgainstCommit),
    summary: row.summary == null ? null : String(row.summary),
    replacement_slug: row.replacementSlug == null ? null : String(row.replacementSlug),
    parent_record_id: row.parentId == null ? null : String(row.parentId),
    parent_slug: null,
    position: Number(row.position ?? 0),
    created_at: String(row.createdAt),
    updated_at: String(row.updatedAt),
    revision: row.latestRevisionId == null ? null : String(row.latestRevisionId),
  }
}

async function hostedRows(filters: DocListFilters): Promise<Doc[]> {
  const client = await hostedDocClient(filters.scope ?? 'global', filters.subject ?? null)
  const rows: HostedRow[] = []
  let cursor: string | null = null
  do {
    const page = await client.listDocs({
      scope: filters.scope,
      subject: filters.subject,
      audience: filters.audience as DocAudience | undefined,
      status: filters.status as Doc['status'] | undefined,
      kind: filters.kind as Doc['kind'] | undefined,
      acrossReadableSpaces: filters.scope === undefined,
      limit: 100,
      cursor,
    })
    if (page.unreadable?.length)
      throw new Error(page.unreadable.map(({ id, reason }) => `${id}: ${reason}`).join('; '))
    rows.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  const match = filters.match?.toLocaleLowerCase()
  const body = filters.bodyMatch?.toLocaleLowerCase()
  return rows
    .map(docFromHosted)
    .filter((doc) => filters.owner === undefined || doc.owner === filters.owner)
    .filter((doc) => !filters.scopes || filters.scopes.includes(doc.scope))
    .filter(
      (doc) =>
        !filters.articleSubject ||
        doc.articleSubject?.id === filters.articleSubject ||
        doc.articleSubject?.name === filters.articleSubject ||
        doc.relatedSubjects.some(
          (subject) =>
            subject.id === filters.articleSubject || subject.name === filters.articleSubject,
        ),
    )
    .filter(
      (doc) =>
        !match ||
        [doc.title, doc.slug, doc.subject ?? ''].some((v) => v.toLocaleLowerCase().includes(match)),
    )
    .filter((doc) => !body || doc.body.toLocaleLowerCase().includes(body))
    .sort((a, b) =>
      filters.updatedAtOrder
        ? (filters.updatedAtOrder === 'asc' ? 1 : -1) * a.updated_at.localeCompare(b.updated_at)
        : a.scope.localeCompare(b.scope) ||
          (a.subject ?? '').localeCompare(b.subject ?? '') ||
          a.slug.localeCompare(b.slug),
    )
}

function withReadRemedy<T>(read: () => Promise<T>): Promise<T> {
  return read().catch((error) => {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `hosted documents could not be read: ${cause}; run ${PLATFORM_SLUG} record whoami to verify sign-in, or retry when the hosted record is reachable`,
    )
  })
}

export function readDocs(filters: DocListFilters = {}): Promise<Doc[]> {
  return applyRecordReadAuthority({
    local: () => listLocalDocs(filters),
    hosted: () => withReadRemedy(() => hostedRows(filters)),
  })
}

export async function readDocMetadata(filters: DocListFilters = {}): Promise<DocMetadata[]> {
  return applyRecordReadAuthority({
    local: () => listLocalDocMetadata(filters),
    hosted: async () =>
      (await hostedRows(filters)).map(
        ({
          body,
          created_at: _created,
          delivery: _delivery,
          owner: _owner,
          project_record_id: _project,
          article_subject_id: _article,
          ...doc
        }) => ({
          ...doc,
          bytes: Buffer.byteLength(body),
          summarySource: doc.summary === null ? 'derived' : 'written',
        }),
      ),
  })
}

export function readDoc(
  scope: string,
  subject: string | null | undefined,
  slug: string,
  owner: string | null = null,
): Promise<Doc | null> {
  return applyRecordReadAuthority({
    local: () => getDocStore(scope, subject, slug, owner),
    hosted: () =>
      withReadRemedy(
        async () =>
          (await hostedRows({ scope, ...(subject !== undefined ? { subject } : {}), owner })).find(
            (doc) => doc.slug === slug,
          ) ?? null,
      ),
  })
}

export function readDocForAudience(
  scope: string,
  subject: string | null | undefined,
  slug: string,
  audience: DocAudience,
  owner: string | null = null,
): Promise<Doc | null> {
  return applyRecordReadAuthority({
    local: () => getDocForAudienceStore(scope, subject, slug, audience, owner),
    hosted: () =>
      withReadRemedy(async () => {
        const doc = (
          await hostedRows({
            scope,
            ...(subject !== undefined ? { subject } : {}),
            owner,
            audience,
          })
        ).find((row) => row.slug === slug)
        return doc ? { ...doc, body: docBodyForAudience(doc.body, audience) } : null
      }),
  })
}

export async function readOpenResumes(cwd: string, now = Date.now()) {
  const project = projectAt(cwd)
  if (!project) return { open: [], unreadable: [] }
  const open: Array<{ slug: string; title: string; age: string; at: number }> = []
  const unreadable: Array<{
    slug: string
    reason: 'no-frontmatter' | 'no-readable-status' | 'unrecognized-status'
  }> = []
  for (const doc of await readDocs({ scope: 'resume', subject: project.name })) {
    const fm = parseResumeFrontmatter(doc.body)
    if (!fm) unreadable.push({ slug: doc.slug, reason: 'no-frontmatter' })
    else if (!fm.status) unreadable.push({ slug: doc.slug, reason: 'no-readable-status' })
    else if (fm.status !== 'open' && fm.status !== 'consumed')
      unreadable.push({ slug: doc.slug, reason: 'unrecognized-status' })
    else if (fm.status === 'open') {
      const at = Date.parse(doc.updated_at || doc.created_at)
      open.push({ slug: doc.slug, title: doc.title, age: resumeAge(at, now), at })
    }
  }
  open.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug))
  return { open, unreadable }
}

export function readDocRevisions(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null = null,
) {
  return applyRecordReadAuthority({
    local: () => listStoredDocRevisions(scope, subject, slug, owner),
    hosted: () =>
      withReadRemedy(async () => {
        const doc = (await hostedRows({ scope, subject, owner })).find((row) => row.slug === slug)
        if (!doc) return []
        const revisions = (await (
          await hostedDocClient(scope, subject)
        ).listRevisions(doc.record_id)) as HostedDocRevision[]
        return hostedDocRevisionRead(revisions).revisions
      }),
  })
}
