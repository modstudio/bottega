// concern: authoritative-document-read
/** Routes operator document reads to their authoritative store. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type DocAudience, effectiveDocSummary } from '../../../shared/docs.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { parseDocRevisionIdentifier } from '../identity/doc-revision-identity.ts'
import { projectByRecordId } from '../project/projects.ts'
import { applyRecordReadAuthority } from '../record/record-read-authority.ts'
import { resolveSubject } from '../subject/subjects.ts'
import {
  hostedDocClient,
  isMissingHostedDoc,
  listAllHostedDocs,
  readHostedDocReference,
} from './doc-hosted-client.ts'
import {
  type HostedDocRevision,
  hostedDocRevisionRead,
  mapHostedDocRevisions,
} from './doc-hosted-history.ts'
import {
  type Doc,
  type DocListFilters,
  type DocMetadata,
  type DocRevision,
  docForAudience,
  getDocForAudienceStore,
  getDocStore,
  listDocMetadataStore,
  listDocsStore,
} from './doc-read-store.ts'
import {
  diffStoredDocRevisions,
  getStoredDocRevision,
  listStoredDocRevisions,
} from './doc-revision-store.ts'

export type AuthoritativeDocHistory = ReturnType<typeof hostedDocRevisionRead>
export type { Doc, DocRevision, DocRevisionMetadata } from './doc-read-store.ts'
export { docForAudience } from './doc-read-store.ts'
export type { DocListFilters }

type HostedRow = Record<string, unknown>

export type ResolvedDocReference = {
  recordId: string
  scope: string
  subject: string | null
  slug: string
  projectName: string | null
  address: string
  updatedAt: string
}

function resolvedReference(row: Doc | HostedRow, projectName: string | null): ResolvedDocReference {
  const hosted = 'id' in row
  const scope = String(row.scope)
  const subject = row.subject == null ? null : String(row.subject)
  const slug = String(row.slug)
  return {
    recordId: String(hosted ? row.id : row.record_id),
    scope,
    subject,
    slug,
    projectName,
    address: `${scope}/${subject ?? '_'}/${slug}`,
    updatedAt: String(hosted ? row.updatedAt : row.updated_at),
  }
}

export function readDocReference(
  value: string,
  database: Database,
): Promise<ResolvedDocReference | null> {
  return applyRecordReadAuthority(
    {
      local: () => {
        const rows = listDocsStore({}, database)
        const row = hasRecordIdShape(value)
          ? rows.find(({ record_id }) => record_id === value)
          : rows.find(({ scope, subject, slug }) => `${scope}/${subject ?? '_'}/${slug}` === value)
        const projectName = row?.project_record_id
          ? (projectByRecordId(row.project_record_id, database)?.name ?? null)
          : null
        return row ? resolvedReference(row, projectName) : null
      },
      hosted: () =>
        withReadRemedy(async () => {
          try {
            const row = await readHostedDocReference(value)
            return resolvedReference(row, row.projectName == null ? null : String(row.projectName))
          } catch (cause) {
            if (isMissingHostedDoc(cause)) return null
            throw cause
          }
        }),
    },
    database,
  )
}

function resolvedFilters(filters: DocListFilters): DocListFilters {
  if (filters.articleSubject === undefined) return filters
  if (filters.scope !== 'project' || !filters.subject)
    throw new Error('article subject filter requires project scope and subject')
  return {
    ...filters,
    articleSubject: resolveSubject(filters.subject, filters.articleSubject).id,
  }
}

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
    bodyTrimmed: row.bodyTrimmed === true,
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
  const page = await listAllHostedDocs(client.listDocs, {
    scope: filters.scope,
    subject: filters.subject,
    slug: filters.slug,
    owner: filters.owner,
    audience: filters.audience as DocAudience | undefined,
    status: filters.status as Doc['status'] | undefined,
    delivery: filters.delivery,
    kind: filters.kind as Doc['kind'] | undefined,
    acrossReadableSpaces:
      filters.scope === undefined || (filters.scope === 'project' && filters.subject == null),
    frontmatterOnly: filters.frontmatterOnly,
  })
  if (page.unreadable.length)
    throw new Error(page.unreadable.map(({ id, reason }) => `${id}: ${reason}`).join('; '))
  return filterAndOrderDocs(page.items.map(docFromHosted), filters)
}

function filterAndOrderDocs(rows: readonly Doc[], filters: DocListFilters): Doc[] {
  const match = filters.match?.toLocaleLowerCase()
  const body = filters.bodyMatch?.toLocaleLowerCase()
  const compareText = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  const hasArticleSubject = (subject: Doc['articleSubject']) =>
    subject?.id === filters.articleSubject || subject?.name === filters.articleSubject
  return rows
    .filter((doc) => doc.owner === (filters.owner ?? null))
    .filter((doc) => !filters.delivery || doc.delivery === filters.delivery)
    .filter((doc) => !filters.scopes || filters.scopes.includes(doc.scope))
    .filter(
      (doc) =>
        !filters.articleSubject ||
        hasArticleSubject(doc.articleSubject) ||
        doc.relatedSubjects.some(hasArticleSubject),
    )
    .filter(
      (doc) =>
        !match ||
        [doc.title, doc.slug, doc.subject ?? ''].some((v) => v.toLocaleLowerCase().includes(match)),
    )
    .filter((doc) => !body || doc.body.toLocaleLowerCase().includes(body))
    .sort((a, b) =>
      filters.updatedAtOrder
        ? (filters.updatedAtOrder === 'asc' ? 1 : -1) * compareText(a.updated_at, b.updated_at) ||
          compareText(a.scope, b.scope) ||
          compareText(a.subject ?? '', b.subject ?? '') ||
          a.position - b.position ||
          compareText(a.title, b.title)
        : (filters.articleSubject
            ? Number(!hasArticleSubject(a.articleSubject)) -
              Number(!hasArticleSubject(b.articleSubject))
            : 0) ||
          compareText(a.scope, b.scope) ||
          compareText(a.subject ?? '', b.subject ?? '') ||
          a.position - b.position ||
          compareText(a.title, b.title),
    )
}

async function hostedSingleDoc(filters: DocListFilters & { slug: string }): Promise<Doc | null> {
  const client = await hostedDocClient(filters.scope ?? 'global', filters.subject ?? null)
  const page = await client.listDocs({
    scope: filters.scope,
    subject: filters.subject,
    slug: filters.slug,
    owner: filters.owner,
    audience: filters.audience as DocAudience | undefined,
    acrossReadableSpaces: filters.subject === undefined,
    limit: filters.subject === undefined ? 2 : 1,
  })
  if (page.unreadable?.length)
    throw new Error(page.unreadable.map(({ id, reason }) => `${id}: ${reason}`).join('; '))
  const docs = page.items.map(docFromHosted)
  const mismatched = docs.find(
    (doc) =>
      doc.slug !== filters.slug ||
      (filters.owner !== undefined && doc.owner !== filters.owner) ||
      (filters.subject !== undefined && doc.subject !== filters.subject),
  )
  if (mismatched) {
    throw new Error(
      `the hosted record API ignored the document filter for ${filters.scope ?? '*'}/${filters.subject ?? '_'}/${filters.slug}; deploy the hosted API, then retry`,
    )
  }
  if (filters.subject === undefined) {
    const subjects = [...new Set(docs.map(({ subject }) => subject ?? '_'))]
    if (subjects.length > 1)
      throw new Error(
        `several ${filters.scope} docs ${JSON.stringify(filters.slug)} match subjects: ${subjects.join(', ')}; pass subject`,
      )
  }
  return docs[0] ?? null
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
  const { frontmatterOnly: _frontmatterOnly, ...localFilters } = filters
  return applyRecordReadAuthority({
    local: () => listDocsStore(resolvedFilters(localFilters)),
    hosted: () => withReadRemedy(() => hostedRows(filters)),
  })
}

export async function readDocMetadata(filters: DocListFilters = {}): Promise<DocMetadata[]> {
  return applyRecordReadAuthority({
    local: () => listDocMetadataStore(resolvedFilters(filters)),
    hosted: () =>
      withReadRemedy(async () =>
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
            ...effectiveDocSummary(doc.summary, body),
          }),
        ),
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
      withReadRemedy(() =>
        hostedSingleDoc({ scope, ...(subject !== undefined ? { subject } : {}), slug, owner }),
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
        const doc = await hostedSingleDoc({
          scope,
          ...(subject !== undefined ? { subject } : {}),
          slug,
          owner,
          audience,
        })
        return doc ? docForAudience(doc, audience, `${scope}/${subject ?? '_'}/${slug}`) : null
      }),
  })
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
      withReadRemedy(
        async () => (await hostedRevisionRead(scope, subject, slug, owner))?.revisions ?? [],
      ),
  })
}

export function readDocRevision(
  revisionId: string,
  owner: string | null = null,
  scope = 'global',
  subject: string | null = null,
): Promise<DocRevision | null> {
  return applyRecordReadAuthority({
    local: () => getStoredDocRevision(revisionId, owner),
    hosted: () =>
      withReadRemedy(async () => {
        const revision = await (await hostedDocClient(scope, subject)).getDocRevision(revisionId)
        const mapped = mapHostedDocRevisions([revision])[0] ?? null
        return mapped?.owner === owner ? mapped : null
      }),
  })
}

async function hostedRevisionRead(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null,
): Promise<AuthoritativeDocHistory | null> {
  const doc = await hostedSingleDoc({ scope, subject, slug, owner })
  if (!doc) return null
  const revisions = (await (
    await hostedDocClient(scope, subject)
  ).listRevisions(doc.record_id)) as HostedDocRevision[]
  return hostedDocRevisionRead(revisions)
}

export function readDocHistory(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null = null,
): Promise<AuthoritativeDocHistory | null> {
  return applyRecordReadAuthority({
    local: () => {
      const revisions = listStoredDocRevisions(scope, subject, slug, owner)
      if (!revisions.length) return null
      const resolve = (identifier: string) => {
        const parsed = parseDocRevisionIdentifier(identifier)
        return (
          (parsed.kind === 'record-id'
            ? revisions.find(({ record_id }) => record_id === parsed.recordId)
            : revisions.find(({ number }) => number === parsed.number)
          )?.record_id ?? identifier
        )
      }
      return {
        revisions,
        resolve,
        revision(identifier: string) {
          const revision = getStoredDocRevision(resolve(identifier), owner)
          if (!revision) throw new Error(`no document revision ${JSON.stringify(identifier)}`)
          return { ...revision, authorName: null }
        },
        diff(a: string | undefined, b: string | undefined) {
          const ordered = revisions.map(({ record_id }) => record_id)
          const left = a ? resolve(a) : ordered[1]
          const right = b ? resolve(b) : ordered[0]
          if (!left || !right)
            throw new Error('doc diff needs two revisions; this address has fewer than two')
          return diffStoredDocRevisions(left, right, owner)
        },
      }
    },
    hosted: () => withReadRemedy(() => hostedRevisionRead(scope, subject, slug, owner)),
  })
}
