/**
 * Operator documents are scoped installation facts. Machine, agent, and job facts may be
 * injected; project and global facts are demand-only, while software instructions are canon.
 * Subject-bearing facts name one subject; resume briefs use the project and epic slug.
 */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assertDocSections } from '../../../shared/doc-sections.ts'
import {
  DOC_SCOPE_ALLOWS_OWNER,
  DOC_SCOPE_SUBJECT_KIND,
  DOC_SCOPES,
  type DocAudience,
  type DocScope,
  type DocStatus,
} from '../../../shared/docs.ts'
import {
  type CanonLintInputCollector,
  collectCanonLintInput as productionCanonLintInput,
} from '../canon/canon-files.ts'
import { type CanonRow, composeCanonRows } from '../canon/canon-hydrate.ts'
import { decideUserCanonImport } from '../canon/canon-write-gate.ts'
import { DEFAULT_PACK_BYTES } from '../canon/pack-budget.ts'
import { db, nowIso, writableDb } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { projectAt, projectByName, projects } from '../project/projects.ts'
import { recordDocArticleCompatibilityRefusal } from '../record/record-doc-transport-contract.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { storedCanonRemovalRefusal } from './canon-removal.ts'
import {
  type DocWriteContext,
  type DocWriteInput,
  hostedArticleWriteFields,
  localRevisionArticleFields,
  localRevisionArticleReferences,
  resolveLocalDocArticleFields,
} from './doc-article-fields.ts'
import { exportDocFiles, importDocFiles } from './doc-files.ts'
import { hostedDocClient } from './doc-hosted-client.ts'
import { storedDocLintRefusal } from './doc-lint-adapter.ts'
import { listDocMetadata, listDocs } from './doc-list.ts'
import {
  type DocOrderInput,
  docOrderRefusal,
  hostedDocOrder,
  type LocalDocOrderRow,
  localDocId,
} from './doc-order.ts'
import {
  type Doc,
  type DocRevision,
  type DocRevisionMetadata,
  docForAudience,
  getDocForAudienceStore,
  getDocStore,
} from './doc-read-store.ts'
import {
  docSubjects,
  validateDocSubject,
  validateHistoricDocAddress,
  validDocSubjects,
} from './doc-subjects.ts'
import { assertWorkerDocStoreWriteAllowed } from './doc-write-guard.ts'
import { executeLocalDocOrder } from './local-doc-order.ts'
import { localDocumentLifecycle } from './local-doc-status.ts'
import {
  assertLocalDocRemovalAllowed,
  localDocTreeFields,
  localParentRecordId,
  localRestoredParentSlug,
} from './local-doc-tree-service.ts'
import {
  commitDocConsume,
  commitDocRemove,
  commitDocRestore,
  commitDocSet,
  executeLocalDocConsume,
  executeLocalDocRemove,
  executeLocalDocRestore,
  executeLocalDocSet,
} from './local-doc-write.ts'

export type { Doc, DocRevision, DocRevisionMetadata }

import { parseResumeFrontmatter, resumeAge, resumeFrontmatter } from './doc-resume-frontmatter.ts'
import {
  assertLocalRevisionWrite,
  currentDocRevision,
  diffStoredDocRevisions,
  getStoredDocRevision,
  listStoredDocRevisions,
} from './doc-revision-store.ts'
import {
  type CanonWriteTree,
  canonFindingsRefusal,
  consumeDocBody,
  docWriteProjectName,
  forcedDocDelivery,
  globalCanonWriteTargets,
  referenceWriteRefusal,
  refuseArticleDelivery,
  refuseCanonWrite,
  refuseOversizedInject,
  refuseOwnedDocAddress,
  refuseProjectOrGlobalInject,
  refuseSettingsAddress,
  refuseSettingsBody,
  userCanonWriteTargets,
} from './doc-write-allowed.ts'
import { resolvedDocWriteIdentity } from './doc-write-identity.ts'

export type { DocWriteContext } from './doc-article-fields.ts'

function assertInjectSize(input: {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  delivery?: 'inject' | 'demand'
  forceInject?: string
}): void {
  if (input.delivery !== 'inject') return
  const current = db().query('SELECT COALESCE(MAX(bytes), 0) AS bytes FROM canon_pack').get() as {
    bytes: number
  }
  const oversized = refuseOversizedInject({
    delivery: 'inject',
    body: input.body,
    forceInject: input.forceInject,
    packBytes: current.bytes,
  })
  if (oversized) throw new Error(oversized)

  if (!['global', 'job', 'project'].includes(input.scope)) return
  const projectRows = db().query('SELECT name,path FROM project ORDER BY name').all() as {
    name: string
    path: string
  }[]
  const projectsToCheck =
    input.scope === 'project'
      ? projectRows.filter((project) => project.name === input.subject)
      : projectRows.length
        ? projectRows
        : [{ name: '_', path: process.cwd() }]
  const jobsToCheck = input.scope === 'job' && input.subject ? [input.subject] : Object.keys(JOBS)
  const identity = `${input.scope}/${input.subject ?? '_'}/${input.slug}`
  for (const project of projectsToCheck) {
    for (const jobName of jobsToCheck) {
      const selected = docsForRun({ job: jobName, cwd: project.path }).filter(
        (doc) => `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}` !== identity,
      )
      const proposed: Doc = {
        id: -1,
        project_id: null,
        scope: input.scope as DocScope,
        subject: input.subject,
        owner: null,
        slug: input.slug,
        title: input.title,
        body: input.body,
        delivery: 'inject',
        audiences: ['technical'],
        featured: false,
        status: 'current',
        kind: 'working',
        form: null,
        article_subject_id: null,
        articleSubject: null,
        relatedSubjects: [],
        sourceFiles: [],
        checkedAgainstCommit: null,
        replacement_slug: null,
        parent_id: null,
        parent_slug: null,
        position: 0,
        created_at: '',
        updated_at: '',
        record_id: null,
        revision: null,
      }
      const docs = [...selected, proposed]
      const packBytes = Buffer.byteLength(docsMarkdown(docs))
      const budget = JOBS[jobName]?.packBytes ?? DEFAULT_PACK_BYTES
      if (packBytes <= budget) continue
      const largest = docs
        .map((doc) => ({
          name: `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`,
          bytes: Buffer.byteLength(`## ${doc.title}\n\n${doc.body}`),
        }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 3)
      throw new Error(
        `canon pack ${jobName}/${project.name} would be ${packBytes} bytes, ` +
          `${packBytes - budget} bytes over its ${budget} byte ceiling\n` +
          `largest inject sections to demote: ${largest.map((doc) => `${doc.name} (${doc.bytes} bytes)`).join(', ')}\n` +
          'cleared by: demote the named largest inject sections to demand documents',
      )
    }
  }
}

function validScope(scope: string): asserts scope is DocScope {
  if (!DOC_SCOPES.includes(scope as DocScope)) {
    throw new Error(`unknown doc scope "${scope}"; valid scopes: ${DOC_SCOPES.join(', ')}`)
  }
}

export function validateDocAddressFilter(filter: { scope?: string; subject?: string }): void {
  if (filter.scope === undefined) return
  validScope(filter.scope)
  if (filter.subject === undefined) return
  validateDocSubject(filter.scope, filter.subject)
}

function validate(scope: string, subject: string | null, slug: string): asserts scope is DocScope {
  validateHistoricDocAddress(scope, slug)
  if (DOC_SCOPE_ALLOWS_OWNER[scope] && subject === null) return
  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  if (subjectKind === null) {
    if (subject !== null) throw new Error(`${scope} docs take no subject; remove --subject`)
    return
  }
  if (!subject)
    throw new Error(`${scope} docs require --subject; valid values: ${validDocSubjects(scope)}`)
  validateDocSubject(scope, subject)
}

export { docSubjects, listDocMetadata, listDocs }

export const getDoc = getDocStore
export const getDocForAudience = getDocForAudienceStore

export { signedInDocOwner } from './doc-owner.ts'

const currentCanon = { scope: 'canon', status: 'current' } as const
function ownedCanonWriteFindings(global: CanonRow[], current: CanonRow[], next: CanonRow[]) {
  const surroundings = userCanonWriteTargets(projects()).map((target) => ({
    global,
    project: target ? listDocs({ ...currentCanon, subject: target.name }) : [],
  }))
  return decideUserCanonImport({ current, next, surroundings }).findings
}

function assertOwnedCanonWriteAllowed(input: DocWriteInput & { owner: string }): void {
  const global = listDocs({ ...currentCanon, subject: null })
  const user = listDocs({ ...currentCanon, subject: null, owner: input.owner })
  const changedRows = input.canonSet ?? [
    ...user.filter(({ slug }) => slug !== input.slug),
    { slug: input.slug, body: input.body },
  ]
  const refusal = canonFindingsRefusal(ownedCanonWriteFindings(global, user, changedRows))
  if (refusal && !input.allowCanonBootstrap) throw new Error(refusal)
}

function assertCanonWriteAllowed(input: DocWriteInput): void {
  if (input.scope !== 'canon') return
  if (input.owner) {
    assertOwnedCanonWriteAllowed({ ...input, owner: input.owner })
    return
  }
  const project = input.subject ? projectByName(input.subject)! : null
  const global = listDocs({ ...currentCanon, subject: null })
  const projectRows = input.subject ? listDocs({ ...currentCanon, subject: input.subject }) : []
  const changedRows = input.canonSet ?? [
    ...(project ? projectRows : global).filter(({ slug }) => slug !== input.slug),
    { slug: input.slug, body: input.body },
  ]
  const next = composeCanonRows(
    (project ? global : changedRows).map((row) => ({ ...row, subject: null })),
    [],
    (project ? changedRows : projectRows).map((row) => ({
      ...row,
      subject: project?.name ?? '',
    })),
  ).map(({ slug, body }) => ({ slug, body }))
  const projectsToCheck = project ? [project] : globalCanonWriteTargets(projects())
  const refusals = projectsToCheck.map((target) => {
    if (!target) {
      return refuseCanonWrite({
        current: global.map(({ slug, body }) => ({ slug, body })),
        next,
      })
    }
    const targetProjectRows = listDocs({ ...currentCanon, subject: target.name })
    const targetCurrent = composeCanonRows(global, [], targetProjectRows).map(({ slug, body }) => ({
      slug,
      body,
    }))
    const targetNext = project
      ? next
      : composeCanonRows(
          changedRows.map((row) => ({ ...row, subject: null })),
          [],
          targetProjectRows,
        ).map(({ slug, body }) => ({ slug, body }))
    const root = input.canonTree?.project.name === target.name ? input.canonTree.root : target.path
    const collected = (input.collectCanonLintInput ?? productionCanonLintInput)(root)
    return refuseCanonWrite({
      current: targetCurrent,
      next: targetNext,
      trackedPaths: collected.trackedPaths,
      packageScripts: collected.packageScripts,
      sourceTexts: collected.sourceTexts,
    })
  })
  const refusal = refusals.find((value) => value)
  if (refusal && !input.allowCanonBootstrap) throw new Error(refusal)
}

function assertCanonRemovalAllowed(
  doc: Doc,
  tree: CanonWriteTree | undefined,
  collectCanonLintInput: CanonLintInputCollector,
): void {
  if (doc.scope !== 'canon') return
  const refusal = storedCanonRemovalRefusal(doc, tree, collectCanonLintInput)
  if (refusal) throw new Error(refusal)
}

function assertDocWriteAllowed(input: DocWriteInput & { delivery: 'inject' | 'demand' }): void {
  const inject = refuseProjectOrGlobalInject(input.scope, input.delivery)
  if (inject) throw new Error(inject)
  const settings = refuseSettingsBody(input.scope, input.body)
  if (settings) throw new Error(settings)
  assertInjectSize(input)
  assertCanonWriteAllowed(input)
}

export {
  lintStoredDoc,
  storedDocWarnings,
} from './doc-lint-adapter.ts'

function assertDocLint(input: DocWriteInput, prior: Doc | null): void {
  if (input.generator) return
  const refusal = storedDocLintRefusal(input, prior, input.canonTree)
  if (refusal) throw new Error(refusal)
}

async function setDocWithOp(input: DocWriteInput, requestedOp?: 'import'): Promise<Doc> {
  writableDb()
  const ownedAddress =
    refuseOwnedDocAddress(input.scope, input.subject, input.owner) ??
    refuseSettingsAddress(input.scope, input.subject, input.owner)
  if (ownedAddress) throw new Error(ownedAddress)
  validate(input.scope, input.subject, input.slug)
  const identity = resolvedDocWriteIdentity(input)
  const owner = input.owner ?? null
  const prior = getDoc(input.scope, input.subject, input.slug, owner)
  const referenceRefusal = referenceWriteRefusal({
    storedForm: prior?.form,
    requestedForm: input.form,
    generator: input.generator,
  })
  if (referenceRefusal) throw new Error(referenceRefusal)
  assertLocalRevisionWrite(input, prior?.revision ?? null, prior === null)
  const delivery = forcedDocDelivery(input.scope) ?? input.delivery ?? prior?.delivery ?? 'inject'
  const kind = input.kind ?? prior?.kind ?? 'working'
  const projectName = docWriteProjectName(input.scope, input.subject)
  const { form, articleSubject, relatedSubjects, sourceFiles, checkedAgainstCommit } =
    resolveLocalDocArticleFields(input, prior, kind, projectName)
  const tree = localDocTreeFields(input, prior)
  assertDocSections(input.body, tree.audiences)
  const lifecycle = localDocumentLifecycle(input, prior)
  const articleDelivery = refuseArticleDelivery({ ...input, delivery, kind })
  if (articleDelivery) throw new Error(articleDelivery)
  assertDocWriteAllowed({ ...input, delivery })
  assertDocLint(input, prior)
  return applyRecordWriteAuthority({
    local: () =>
      executeLocalDocSet({
        ...input,
        owner,
        prior,
        projectId: projectName ? projectByName(input.subject!)!.id : null,
        delivery,
        ...tree,
        ...lifecycle,
        form,
        articleSubject,
        relatedSubjects,
        sourceFiles,
        checkedAgainstCommit,
        requestedOp,
        identity,
      }),
    hosted: async () => {
      const client = await hostedDocClient(input.scope, input.subject)
      const hostedInput: Parameters<typeof client.upsertDoc>[0] = {
        scope: input.scope,
        subject: input.subject,
        owner,
        slug: input.slug,
        title: input.title,
        body: input.body,
        delivery,
        audiences: tree.audiences,
        parentRecordId: localParentRecordId({
          scope: input.scope,
          subject: input.subject,
          owner,
          parent_id: tree.parentId,
          parent_slug: tree.parentSlug,
        }),
        position: tree.position,
        featured: tree.featured,
        kind,
        ...hostedArticleWriteFields(input, {
          form,
          articleSubject,
          relatedSubjects,
          sourceFiles,
          checkedAgainstCommit,
        }),
        status: lifecycle.status,
        replacementSlug: lifecycle.replacementSlug,
        projectName,
        reason: identity.reason,
        author: identity.author,
        forceInject: input.forceInject,
        op: requestedOp ?? (prior ? 'set' : 'create'),
        id: prior?.record_id ?? undefined,
        expectedRevision: input.expectedRevision,
        generator: input.generator,
      }
      const hosted = await client.upsertDoc(hostedInput)
      const compatibilityRefusal = recordDocArticleCompatibilityRefusal([hostedInput], hosted)
      if (compatibilityRefusal) throw new Error(compatibilityRefusal)
      return commitDocSet({
        ...input,
        owner,
        projectId: projectName ? projectByName(input.subject!)!.id : null,
        delivery,
        ...tree,
        ...lifecycle,
        form,
        articleSubject,
        relatedSubjects,
        sourceFiles,
        checkedAgainstCommit,
        requestedOp,
        identity,
        recordId: hosted.id,
        revisionId: hosted.revisionId,
      })
    },
  })
}

export async function setDoc(input: DocWriteInput): Promise<Doc> {
  assertWorkerDocStoreWriteAllowed('setDoc')
  if (input.scope === 'resume') {
    const frontmatter = resumeFrontmatter(input.body)
    if (!frontmatter?.top.status) {
      throw new Error(
        `resume doc "${input.slug}" requires readable top-level YAML frontmatter in the shape "status: open" or "status: consumed"`,
      )
    }
    if (frontmatter.status?.occurrences && frontmatter.status.occurrences > 1) {
      throw new Error(`resume doc "${input.slug}" has more than one top-level status field`)
    }
    const status = frontmatter.top.status
    if (status !== 'open' && status !== 'consumed') {
      throw new Error(
        `resume doc "${input.slug}" has unrecognized status "${status}"; permitted values are "open" and "consumed"`,
      )
    }
  }
  return setDocWithOp(input)
}

export async function reorderDocs(input: DocOrderInput): Promise<{ orderedIds: string[] }> {
  assertWorkerDocStoreWriteAllowed('reorderDocs')
  return applyRecordWriteAuthority({
    local: () => executeLocalDocOrder(input),
    hosted: async () => {
      const parentId = input.parentId === null ? null : localDocId(input.parentId)
      const siblings = db()
        .query<LocalDocOrderRow, [string, string, number | null]>(
          `SELECT id, slug, record_id FROM doc
           WHERE scope=? AND COALESCE(subject, '')=? AND parent_id IS ?
           ORDER BY position, title, id`,
        )
        .all(input.scope, input.subject ?? '', parentId)
      const refusal = docOrderRefusal(
        siblings.map((row) => String(row.id)),
        input.orderedIds,
      )
      if (refusal) throw new Error(refusal)
      const parent =
        parentId === null
          ? null
          : (db()
              .query<LocalDocOrderRow, [number]>('SELECT id, slug, record_id FROM doc WHERE id=?')
              .get(parentId) ?? null)
      const client = await hostedDocClient(input.scope, input.subject)
      await client.reorderDocs(
        hostedDocOrder(
          input,
          siblings,
          parent,
          `run ${PLATFORM_SLUG} record push-docs before reordering documents`,
        ),
      )
      return executeLocalDocOrder(input)
    },
  })
}

export async function setDocStatus(
  scope: string,
  subject: string | null,
  slug: string,
  status: DocStatus,
  replacementSlug: string | null | undefined,
  context: DocWriteContext,
  owner: string | null = null,
): Promise<Doc> {
  const current = getDoc(scope, subject, slug, owner)
  if (!current)
    throw new Error(`no ${scope} doc "${slug}"; use ${PLATFORM_SLUG} doc list --scope ${scope}`)
  return setDoc({
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
    status,
    replacementSlug,
    ...context,
  })
}

export async function importDoc(
  input: {
    scope: string
    subject: string | null
    slug: string
    title: string
    body: string
    delivery?: 'inject' | 'demand'
  } & DocWriteContext,
): Promise<Doc> {
  assertWorkerDocStoreWriteAllowed('importDoc')
  return setDocWithOp(input, 'import')
}

export async function removeDoc(
  scope: string,
  subject: string | null,
  slug: string,
  context: DocWriteContext,
  owner: string | null = null,
): Promise<boolean> {
  assertWorkerDocStoreWriteAllowed('removeDoc')
  writableDb()
  validScope(scope)
  const identity = resolvedDocWriteIdentity(context)
  const doc = getDoc(scope, subject, slug, owner)
  if (!doc) return false
  const referenceRefusal = referenceWriteRefusal({
    storedForm: doc.form,
    generator: context.generator,
  })
  if (referenceRefusal) throw new Error(referenceRefusal)
  assertLocalRevisionWrite(
    { scope, expectedRevision: context.expectedRevision },
    doc.revision,
    false,
  )
  if (context.canonRemovalDecision !== 'already-decided-next-set') {
    assertCanonRemovalAllowed(
      doc,
      context.canonTree,
      context.collectCanonLintInput ?? productionCanonLintInput,
    )
  }
  assertLocalDocRemovalAllowed(doc)
  return applyRecordWriteAuthority({
    local: () => executeLocalDocRemove({ scope, subject, owner, slug, doc, identity, ...context }),
    hosted: async () => {
      const client = await hostedDocClient(doc.scope, doc.subject)
      let recordId = doc.record_id
      let hostedExpected = context.expectedRevision
      if (!recordId) {
        const created = await client.upsertDoc({
          scope: doc.scope,
          subject: doc.subject,
          owner: doc.owner,
          slug: doc.slug,
          title: doc.title,
          body: doc.body,
          delivery: doc.delivery,
          audiences: doc.audiences,
          parentRecordId: localParentRecordId(doc),
          position: doc.position,
          featured: doc.featured,
          projectName: docWriteProjectName(doc.scope, doc.subject),
          reason: identity.reason,
          author: identity.author,
          id: undefined,
          expectedRevision: context.expectedRevision,
          generator: context.generator,
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await client.deleteDoc(recordId, {
        reason: identity.reason,
        author: identity.author,
        expectedRevision: hostedExpected,
        generator: context.generator,
      })
      return commitDocRemove({
        scope,
        subject,
        owner,
        slug,
        identity,
        ...context,
        revisionId: hosted.revisionId,
      })
    },
  })
}

/**
 * Consuming a resume changes metadata inside a body whose exact text is the
 * recovery artifact. Patch only the three named fields instead of parsing and
 * serializing YAML, which would rewrite unrelated whitespace and ordering.
 */
export async function consumeDoc(
  scope: string,
  subject: string | null,
  slug: string,
  context: DocWriteContext,
): Promise<Doc & { already_consumed: boolean }> {
  assertWorkerDocStoreWriteAllowed('consumeDoc')
  writableDb()
  validateHistoricDocAddress(scope, slug)
  const identity = resolvedDocWriteIdentity(context)
  const doc = getDoc(scope, subject, slug)
  if (!doc) throw new Error(`no ${scope} doc "${slug}"`)
  const consumedAt = nowIso()
  let patched: { body: string; alreadyConsumed: boolean }
  try {
    patched = consumeDocBody(doc.body, consumedAt, identity.session ?? identity.author)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${scope} doc "${slug}" ${message.replace(/^document /, '')}`)
  }
  if (patched.alreadyConsumed) return { ...doc, already_consumed: true }
  assertDocSections(patched.body, doc.audiences)
  assertLocalRevisionWrite(
    { scope, expectedRevision: context.expectedRevision },
    doc.revision,
    false,
  )
  return applyRecordWriteAuthority({
    local: () =>
      executeLocalDocConsume({
        scope,
        subject,
        owner: null,
        slug,
        doc,
        body: patched.body,
        consumedAt,
        identity,
        ...context,
      }),
    hosted: async () => {
      const client = await hostedDocClient(doc.scope, doc.subject)
      let recordId = doc.record_id
      let hostedExpected = context.expectedRevision
      if (!recordId) {
        const created = await client.upsertDoc({
          scope: doc.scope,
          subject: doc.subject,
          slug: doc.slug,
          title: doc.title,
          body: doc.body,
          delivery: doc.delivery,
          audiences: doc.audiences,
          parentRecordId: localParentRecordId(doc),
          position: doc.position,
          featured: doc.featured,
          projectName: docWriteProjectName(doc.scope, doc.subject),
          reason: identity.reason,
          author: identity.author,
          expectedRevision: context.expectedRevision,
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await client.consumeDoc(recordId, {
        reason: identity.reason,
        author: identity.author,
        expectedRevision: hostedExpected,
      })
      if (hosted.alreadyConsumed) return { ...doc, already_consumed: true }
      return commitDocConsume({
        scope,
        subject,
        owner: null,
        slug,
        body: patched.body,
        consumedAt,
        identity,
        ...context,
        recordId: hosted.id,
        revisionId: hosted.revisionId,
      })
    },
  })
}

export type InjectedDoc = Doc & { revision_id: number }

export function docsForRun(input: { job: string; cwd: string }): InjectedDoc[] {
  const project = projectAt(input.cwd)
  const docs = [
    ...listDocs({ scope: 'global', subject: null, status: 'current' }),
    ...listDocs({ scope: 'job', subject: input.job, status: 'current' }),
    ...(project ? listDocs({ scope: 'project', subject: project.name, status: 'current' }) : []),
  ].filter((doc) => doc.delivery === 'inject')
  const latest = db().query('SELECT MAX(id) AS id FROM doc_revision WHERE doc_id=?')
  return docs.map((doc) => {
    const revisionId = (latest.get(doc.id) as { id: number | null }).id
    if (revisionId === null) {
      throw new Error(
        `doc ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} has no revision; refusing run`,
      )
    }
    return { ...doc, revision_id: revisionId }
  })
}

export function docsMarkdown(docs: Doc[]): string {
  return docs.map((doc) => `## ${doc.title}\n\n${doc.body}`).join('\n\n')
}

type OpenResume = { slug: string; title: string; age: string; at: number }
type UnreadableResume = {
  slug: string
  reason: 'no-frontmatter' | 'no-readable-status' | 'unrecognized-status'
}
export type OpenResumeList = { open: OpenResume[]; unreadable: UnreadableResume[] }

function resumeTimestampMs(updatedAt: string, createdAt: string): number {
  const updated = Date.parse(updatedAt)
  if (!Number.isNaN(updated)) return updated
  const fallback = Date.parse(createdAt)
  return Number.isNaN(fallback) ? 0 : fallback
}

export function listOpenResumes(cwd: string, now = Date.now()): OpenResumeList {
  const project = projectAt(cwd)
  if (!project) return { open: [], unreadable: [] }
  const open: OpenResume[] = []
  const unreadable: UnreadableResume[] = []
  for (const doc of listDocs({ scope: 'resume', subject: project.name })) {
    const fm = parseResumeFrontmatter(doc.body)
    if (!fm) {
      unreadable.push({ slug: doc.slug, reason: 'no-frontmatter' })
      continue
    }
    if (!fm.status) {
      unreadable.push({ slug: doc.slug, reason: 'no-readable-status' })
      continue
    }
    if (fm.status !== 'open' && fm.status !== 'consumed') {
      unreadable.push({ slug: doc.slug, reason: 'unrecognized-status' })
      continue
    }
    if (fm.status !== 'open') continue
    const at = resumeTimestampMs(doc.updated_at, doc.created_at)
    open.push({ slug: doc.slug, title: doc.title, age: resumeAge(at, now), at })
  }
  open.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug))
  return { open, unreadable }
}

export function exportDocs(dir: string): number {
  return exportDocFiles(dir, listDocs())
}

export async function importDocs(dir: string, context: DocWriteContext): Promise<number> {
  assertWorkerDocStoreWriteAllowed('importDocs')
  writableDb()
  resolvedDocWriteIdentity(context)
  return importDocFiles(dir, async (doc) => {
    await setDocWithOp(
      {
        ...doc,
        ...context,
        expectedRevision: getDoc(doc.scope, doc.subject, doc.slug)?.revision ?? undefined,
      },
      'import',
    )
  })
}

export function listDocRevisions(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null = null,
): DocRevisionMetadata[] {
  return listStoredDocRevisions(scope, subject, slug, owner)
}

export const getDocRevision = getStoredDocRevision

export function readDocRevision(
  scope: string,
  subject: string | null,
  slug: string,
  id: number,
  owner: string | null = null,
  audience?: DocAudience,
): DocRevision {
  const revision = getDocRevision(id, owner)
  if (
    !revision ||
    revision.scope !== scope ||
    revision.subject !== subject ||
    revision.slug !== slug
  )
    throw new Error(
      `revision ${id} does not belong to ${scope}/${subject ?? '_'}/${slug}; run ${PLATFORM_SLUG} doc history ${scope} ${subject ?? '-'} ${slug}`,
    )
  return audience
    ? docForAudience(revision, audience, `${scope}/${subject ?? '_'}/${slug} revision ${id}`)
    : revision
}

export async function restoreDoc(
  scope: string,
  subject: string | null,
  slug: string,
  revisionId: number,
  context: DocWriteContext,
  owner: string | null = null,
): Promise<Doc> {
  assertWorkerDocStoreWriteAllowed('restoreDoc')
  writableDb()
  validateHistoricDocAddress(scope, slug)
  const identity = resolvedDocWriteIdentity(context)
  const revision = getDocRevision(revisionId, owner)
  if (
    !revision ||
    revision.scope !== scope ||
    revision.subject !== subject ||
    revision.owner !== owner ||
    revision.slug !== slug
  ) {
    throw new Error(`no revision ${revisionId} for ${scope}/${subject ?? '_'}/${slug}`)
  }
  const expectedCurrent = currentDocRevision(scope, subject, slug, owner)
  assertLocalRevisionWrite(
    { scope, expectedRevision: context.expectedRevision },
    expectedCurrent,
    false,
  )
  assertDocWriteAllowed({
    scope,
    subject,
    owner,
    slug,
    title: revision.title,
    body: revision.body,
    delivery: revision.delivery,
    ...context,
  })
  assertDocLint(
    {
      scope,
      subject,
      owner,
      slug,
      title: revision.title,
      body: revision.body,
      delivery: revision.delivery,
      kind: revision.kind,
      ...localRevisionArticleReferences(revision),
      ...context,
    },
    getDoc(scope, subject, slug, owner),
  )
  const projectName = docWriteProjectName(scope, subject)
  const projectId = projectName ? (projectByName(subject!)?.id ?? null) : null
  const liveRecordId = getDoc(scope, subject, slug, owner)?.record_id
  const restoredParentSlug = localRestoredParentSlug({
    scope,
    subject,
    slug,
    parentId: revision.parent_id,
  })
  const tree = localDocTreeFields(
    {
      scope,
      subject,
      owner,
      slug,
      title: revision.title,
      body: revision.body,
      delivery: revision.delivery,
      audiences: revision.audiences,
      parentSlug: restoredParentSlug,
      position: revision.position,
      featured: revision.featured,
      ...context,
    },
    getDoc(scope, subject, slug, owner),
  )
  assertDocSections(revision.body, tree.audiences)
  return applyRecordWriteAuthority({
    // A removed local document has no live row retaining its document UUID. Restore mints a
    // new document UUID while its revision history remains continuous by address.
    local: () =>
      executeLocalDocRestore({
        scope,
        subject,
        owner,
        slug,
        liveRecordId,
        projectId,
        title: revision.title,
        body: revision.body,
        delivery: revision.delivery,
        ...tree,
        status: revision.status,
        kind: revision.kind,
        ...localRevisionArticleFields(revision),
        replacementSlug: revision.replacement_slug,
        identity,
        ...context,
      }),
    hosted: async () => {
      const client = await hostedDocClient(scope, subject)
      let recordId = liveRecordId
      let hostedExpected = context.expectedRevision
      if (!recordId) {
        const listed = await client.listDocs({
          scope,
          subject,
          includeDeleted: true,
          limit: 100,
        })
        const match = listed.items.find(
          (row) =>
            String(row.slug) === slug &&
            (row.subject ?? null) === subject &&
            (row.owner ?? null) === owner,
        )
        recordId = match && typeof match.id === 'string' ? match.id : null
      }
      if (!recordId) {
        const created = await client.upsertDoc({
          scope,
          subject,
          owner,
          slug,
          title: revision.title,
          body: revision.body,
          delivery: revision.delivery,
          audiences: revision.audiences,
          parentRecordId: localParentRecordId({
            scope,
            subject,
            owner,
            parent_id: tree.parentId,
            parent_slug: tree.parentSlug,
          }),
          position: revision.position,
          featured: revision.featured,
          status: revision.status,
          kind: revision.kind,
          ...hostedArticleWriteFields(localRevisionArticleReferences(revision), {
            ...localRevisionArticleFields(revision),
          }),
          replacementSlug: revision.replacement_slug,
          projectName,
          reason: identity.reason,
          author: identity.author,
          op: 'restore',
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await client.restoreDoc(recordId, {
        revisionId: revision.record_id ?? recordId,
        reason: identity.reason,
        author: identity.author,
        expectedRevision: hostedExpected,
      })
      return commitDocRestore({
        scope,
        subject,
        owner,
        slug,
        projectId,
        title: revision.title,
        body: revision.body,
        delivery: revision.delivery,
        ...tree,
        status: revision.status,
        kind: revision.kind,
        ...localRevisionArticleFields(revision),
        replacementSlug: revision.replacement_slug,
        identity,
        ...context,
        recordId: hosted.id,
        revisionId: hosted.revisionId,
      })
    },
  })
}

export function diffDocRevisions(a: number, b: number, owner: string | null = null): string {
  return diffStoredDocRevisions(a, b, owner)
}
