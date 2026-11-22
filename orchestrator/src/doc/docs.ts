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
  type DocScope,
  type DocStatus,
} from '../../../shared/docs.ts'
import { collectCanonLintInput as productionCanonLintInput } from '../canon/canon-files.ts'
import { type CanonRow, composeCanonRows } from '../canon/canon-hydrate.ts'
import { decideNextCanonSet, decideUserCanonImport } from '../canon/canon-write-gate.ts'
import { DEFAULT_PACK_BYTES } from '../canon/pack-budget.ts'
import {
  joinPackSections,
  packedCanonMarkdownFromRows,
  renderPackDocSection,
} from '../canon/pack-content.ts'
import { db, nowIso, writableDb } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { projectAt, projectByName, projects } from '../project/projects.ts'
import { recordDocArticleCompatibilityRefusal } from '../record/record-doc-transport-contract.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import {
  assertLocalArticleDelivery,
  type DocWriteContext,
  type DocWriteInput,
  hostedArticleWriteFields,
  hostedDocWriteFields,
  localRevisionArticleFields,
  localRevisionArticleReferences,
  resolveLocalDocArticleFields,
} from './doc-article-fields.ts'
import { readDoc, readDocs } from './doc-authoritative-read.ts'
import { assertDocBodyCommands, assertStoredDocBodyCommands } from './doc-command-check.ts'
import { exportDocFiles, importDocFiles } from './doc-files.ts'
import { contextTaskOwner, hostedDocClient } from './doc-hosted-client.ts'
import {
  assertDocWriteRevisionForAuthority,
  hostedDocWriteOperation,
} from './doc-hosted-write-operation.ts'
import { isDocInjectedForRun } from './doc-injection.ts'
import { storedDocLintRefusal } from './doc-lint-adapter.ts'
import { type DocOrderInput, docOrderRefusal, type LocalDocOrderRow } from './doc-order.ts'
import { assertDocProse } from './doc-prose.ts'
import { type Doc, type DocRevision, getDocStore, listDocsStore } from './doc-read-store.ts'
import {
  assertLocalReferenceRestore,
  assertLocalReferenceWrite,
  assertLocalStoredReferenceWrite,
  skipsProseLint,
} from './doc-reference-write.ts'
import { type DocRemovalContext, removeStoredDoc } from './doc-remove.ts'
import { referenceRestoreState } from './doc-restore-state.ts'
import * as rw from './doc-resume-write.ts'
import { addSecretScanWarning, defaultDocSecretScanner, scanDocBody } from './doc-secret-scan.ts'
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
  localDocTreeFields,
  localParentRecordId,
  localRestoredParentSlug,
} from './local-doc-tree-service.ts'
import {
  commitDocConsume,
  commitDocRestore,
  commitDocSet,
  executeLocalDocConsume,
  executeLocalDocRestore,
  executeLocalDocSet,
} from './local-doc-write.ts'

export type { Doc, DocRevision }
export type ConsumedDoc = Doc & { already_consumed: boolean }

import { parseResumeFrontmatter, resumeAge, resumeFrontmatter } from './doc-resume-frontmatter.ts'
import { assertLocalRevisionWrite, getStoredDocRevision } from './doc-revision-store.ts'
import {
  addCanonWriteWarnings,
  canonFindingsRefusal,
  canonFindingWarnings,
  consumeDocBody,
  docWriteProjectName,
  forcedDocDelivery,
  globalCanonWriteTargets,
  injectPackBudgetRefusal,
  refuseOversizedInject,
  refuseOwnedDocAddress,
  refuseProjectOrGlobalInject,
  refuseSettingsAddress,
  refuseSettingsBody,
  userCanonWriteTargets,
} from './doc-write-allowed.ts'
import { hostedDocWriteIdentity, resolvedDocWriteIdentity } from './doc-write-identity.ts'

export type { DocWriteContext } from './doc-article-fields.ts'

const getDoc = getDocStore
const listDocs = listDocsStore

async function assertSetDocAllowed(input: DocWriteInput): Promise<void> {
  assertWorkerDocStoreWriteAllowed('setDoc')
  if (input.scope !== 'resume') return
  const refusal = rw.resumeWriteRefusal(input.slug, input.body, resumeFrontmatter(input.body))
  if (refusal) throw new Error(refusal)
}

type DocWriteAllowedInput = DocWriteInput & { delivery: 'inject' | 'demand' }

async function assertRestoredDocWriteAllowed(input: DocWriteAllowedInput): Promise<string[]> {
  const warnings = await assertDocWriteAllowed(input)
  if (input.scope !== 'resume') return warnings
  const refusal = rw.resumeRestoreRefusal(
    rw.resumeWriteRefusal(input.slug, input.body, resumeFrontmatter(input.body)),
  )
  if (refusal) throw new Error(refusal)
  return warnings
}

function injectedDocsForPack(job: string, projectName: string | null): Doc[] {
  return [
    ...listDocs({ scope: 'global', subject: null, status: 'current' }),
    ...listDocs({ scope: 'job', subject: job, status: 'current' }),
    ...(projectName ? listDocs({ scope: 'project', subject: projectName, status: 'current' }) : []),
  ].filter((doc) => isDocInjectedForRun(doc, job, projectName))
}

type PackSizeInput = {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  delivery?: 'inject' | 'demand'
  forceInject?: string
}

type PackProject = { name: string; path: string }

function assertIndividualInjectSize(input: PackSizeInput): void {
  if (input.delivery !== 'inject') return
  const current = db().query('SELECT COALESCE(MAX(bytes), 0) AS bytes FROM canon_pack').get() as {
    bytes: number
  }
  const refusal = refuseOversizedInject({
    delivery: 'inject',
    body: input.body,
    forceInject: input.forceInject,
    packBytes: current.bytes,
  })
  if (refusal) throw new Error(refusal)
}

function affectedPackProjects(input: PackSizeInput, projectRows: PackProject[]): PackProject[] {
  if (input.scope === 'canon') {
    return input.subject === null
      ? projectRows
      : projectRows.filter((project) => project.name === input.subject)
  }
  if (input.scope === 'project') {
    return projectRows.filter((project) => project.name === input.subject)
  }
  return projectRows.length ? projectRows : [{ name: '_', path: process.cwd() }]
}

function canonForPackWrite(input: PackSizeInput, projectName: string, identity: string) {
  const globalCanon = listDocs({ scope: 'canon', subject: null, status: 'current' }).filter(
    (doc) => `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}` !== identity,
  )
  const projectCanon = listDocs({ scope: 'canon', subject: projectName, status: 'current' }).filter(
    (doc) => `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}` !== identity,
  )
  if (input.scope !== 'canon') {
    return packedCanonMarkdownFromRows(projectName, globalCanon, projectCanon)
  }
  const proposed = { subject: input.subject, slug: input.slug, body: input.body }
  return packedCanonMarkdownFromRows(
    projectName,
    input.subject === null ? [...globalCanon, proposed] : globalCanon,
    input.subject === projectName ? [...projectCanon, proposed] : projectCanon,
  )
}

function packBudgetRefusalFor(
  input: PackSizeInput,
  project: PackProject,
  jobName: string,
): string | null {
  const identity = `${input.scope}/${input.subject ?? '_'}/${input.slug}`
  const selected = injectedDocsForPack(jobName, project.name).filter(
    (doc) => `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}` !== identity,
  )
  const canon = canonForPackWrite(input, project.name, identity)
  return injectPackBudgetRefusal({
    job: jobName,
    project: project.name,
    ceiling: JOBS[jobName]?.packBytes ?? DEFAULT_PACK_BYTES,
    canonMarkdown: canon.markdown,
    canonTiers: [
      { label: 'always-on', bytes: canon.alwaysOnBytes },
      { label: 'context-index', bytes: canon.contextIndexBytes },
    ],
    current: selected.map((doc) => ({
      identity: `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`,
      title: doc.title,
      body: doc.body,
    })),
    proposed:
      input.delivery === 'inject' ? { identity, title: input.title, body: input.body } : undefined,
  })
}

function assertPackSize(input: PackSizeInput): void {
  assertIndividualInjectSize(input)
  const measuresPack =
    input.scope === 'canon' ||
    (input.delivery === 'inject' && ['global', 'job', 'project'].includes(input.scope))
  if (!measuresPack) return
  const projectRows = db().query('SELECT name,path FROM project ORDER BY name').all() as {
    name: string
    path: string
  }[]
  const projectsToCheck = affectedPackProjects(input, projectRows)
  const jobsToCheck = input.scope === 'job' && input.subject ? [input.subject] : Object.keys(JOBS)
  for (const project of projectsToCheck) {
    for (const jobName of jobsToCheck) {
      const refusal = packBudgetRefusalFor(input, project, jobName)
      if (refusal) throw new Error(refusal)
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

export { readHostedUserSettingsDocuments } from './doc-hosted-client.ts'
export { signedInDocOwner } from './doc-owner.ts'
export { docSubjects }

const currentCanon = { scope: 'canon', status: 'current' } as const
function ownedCanonWriteFindings(global: CanonRow[], current: CanonRow[], next: CanonRow[]) {
  const surroundings = userCanonWriteTargets(projects()).map((target) => ({
    global,
    project: target ? listDocs({ ...currentCanon, subject: target.name }) : [],
  }))
  return decideUserCanonImport({ current, next, surroundings }).findings
}

function assertOwnedCanonWriteAllowed(input: DocWriteInput & { owner: string }): string[] {
  const global = listDocs({ ...currentCanon, subject: null })
  const user = listDocs({ ...currentCanon, subject: null, owner: input.owner })
  const changedRows = input.canonSet ?? [
    ...user.filter(({ slug }) => slug !== input.slug),
    { slug: input.slug, body: input.body },
  ]
  const findings = ownedCanonWriteFindings(global, user, changedRows)
  const refusal = canonFindingsRefusal(findings)
  if (refusal && !input.allowCanonBootstrap) throw new Error(refusal)
  return canonFindingWarnings(findings)
}

function assertCanonWriteAllowed(input: DocWriteInput): string[] {
  if (input.scope !== 'canon') return []
  if (input.owner) {
    return assertOwnedCanonWriteAllowed({ ...input, owner: input.owner })
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
  const decisions = projectsToCheck.map((target) => {
    if (!target) {
      const findings = decideNextCanonSet({
        current: global.map(({ slug, body }) => ({ slug, body })),
        next,
      })
      return { refusal: canonFindingsRefusal(findings), warnings: canonFindingWarnings(findings) }
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
    const findings = decideNextCanonSet({
      current: targetCurrent,
      next: targetNext,
      trackedPaths: collected.trackedPaths,
      packageScripts: collected.packageScripts,
      sourceTexts: collected.sourceTexts,
    })
    return { refusal: canonFindingsRefusal(findings), warnings: canonFindingWarnings(findings) }
  })
  const refusal = decisions.find(({ refusal: value }) => value)?.refusal
  if (refusal && !input.allowCanonBootstrap) throw new Error(refusal)
  return [...new Set(decisions.flatMap(({ warnings }) => warnings))]
}

async function assertDocWriteAllowed(input: DocWriteAllowedInput): Promise<string[]> {
  const inject = refuseProjectOrGlobalInject(input.scope, input.delivery)
  if (inject) throw new Error(inject)
  const settings = refuseSettingsBody(input.scope, input.body)
  if (settings) throw new Error(settings)
  assertPackSize(input)
  return assertCanonWriteAllowed(input)
}

export { summarizeDocLint } from './doc-lint.ts'
export {
  lintStoredDoc,
  storedDocWarnings,
} from './doc-lint-adapter.ts'

function assertDocLint(input: DocWriteInput, prior: Doc | null): void {
  assertLocalReferenceWrite(prior, input)
  if (skipsProseLint(prior, input)) return
  const refusal = storedDocLintRefusal(input, prior, input.canonTree)
  if (refusal) throw new Error(refusal)
}

function localDocWriteState(input: DocWriteInput): { owner: string | null; prior: Doc | null } {
  const owner = input.owner ?? null
  return { owner, prior: getDoc(input.scope, input.subject, input.slug, owner) }
}

const hostedDocWriteClient = (input: DocWriteInput) =>
  hostedDocClient(input.scope, input.subject, contextTaskOwner(input.contextTask))

async function setDocWithOp(
  input: DocWriteInput,
  requestedOp?: 'import',
): Promise<Doc & { writeWarnings?: string[] }> {
  writableDb()
  const ownedAddress =
    refuseOwnedDocAddress(input.scope, input.subject, input.owner) ??
    refuseSettingsAddress(input.scope, input.subject, input.owner)
  if (ownedAddress) throw new Error(ownedAddress)
  validate(input.scope, input.subject, input.slug)
  const secretScan = scanDocBody(input, defaultDocSecretScanner)
  const identity = resolvedDocWriteIdentity(input)
  const { owner, prior } = localDocWriteState(input)
  assertDocWriteRevisionForAuthority(input, prior?.revision ?? null, prior === null)
  const delivery = forcedDocDelivery(input.scope) ?? input.delivery ?? prior?.delivery ?? 'inject'
  const kind = input.kind ?? prior?.kind ?? 'working'
  const projectName = docWriteProjectName(input.scope, input.subject)
  const articleFields = resolveLocalDocArticleFields(input, prior, kind, projectName)
  const tree = localDocTreeFields(input, prior)
  assertDocBodyCommands(input, { kind, form: articleFields.form, audiences: tree.audiences })
  const lifecycle = localDocumentLifecycle(input, prior)
  assertLocalArticleDelivery(input, delivery, kind)
  const canonWarnings = await assertDocWriteAllowed({ ...input, delivery })
  assertDocLint(input, prior)
  await assertDocProse(input, prior)
  const written = await applyRecordWriteAuthority({
    local: () =>
      executeLocalDocSet({
        ...input,
        owner,
        prior,
        projectId: projectName ? projectByName(input.subject!)!.recordId : null,
        delivery,
        ...tree,
        ...lifecycle,
        ...articleFields,
        requestedOp,
        identity,
      }),
    hosted: async () => {
      const client = await hostedDocWriteClient(input)
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
          parent_record_id: tree.parentId,
          parent_slug: tree.parentSlug,
        }),
        position: tree.position,
        featured: tree.featured,
        kind,
        ...hostedDocWriteFields(input, articleFields),
        status: lifecycle.status,
        replacementSlug: lifecycle.replacementSlug,
        projectName,
        ...hostedDocWriteIdentity(identity),
        forceInject: input.forceInject,
        op: hostedDocWriteOperation(requestedOp, prior, input.expectedRevision),
        id: prior?.record_id ?? undefined,
        expectedRevision: input.expectedRevision,
      }
      const hosted = await client.upsertDoc(hostedInput)
      const compatibilityRefusal = recordDocArticleCompatibilityRefusal([hostedInput], hosted)
      if (compatibilityRefusal) throw new Error(compatibilityRefusal)
      return commitDocSet({
        ...input,
        expectedRevision: prior?.revision ?? undefined,
        owner,
        projectId: projectName ? projectByName(input.subject!)!.recordId : null,
        delivery,
        ...tree,
        ...lifecycle,
        ...articleFields,
        requestedOp,
        identity,
        recordId: hosted.id,
        revisionId: hosted.revisionId,
      })
    },
  })
  return addSecretScanWarning(addCanonWriteWarnings(written, canonWarnings), input, secretScan)
}

export async function setDoc(input: DocWriteInput): Promise<Doc & { writeWarnings?: string[] }> {
  await assertSetDocAllowed(input)
  const prior = getDoc(input.scope, input.subject, input.slug, input.owner ?? null)
  const refusal = rw.resumeConsumptionWriteRefusal(input, prior?.body ?? null)
  if (refusal) throw new Error(refusal)
  return setDocWithOp(input)
}

export async function reorderDocs(input: DocOrderInput): Promise<{ orderedIds: string[] }> {
  assertWorkerDocStoreWriteAllowed('reorderDocs')
  return applyRecordWriteAuthority({
    local: () => executeLocalDocOrder(input),
    hosted: async () => {
      const siblings = db()
        .query<LocalDocOrderRow, [string, string, string | null]>(
          `SELECT record_id, slug FROM doc
           WHERE scope=? AND COALESCE(subject, '')=? AND parent_record_id IS ?
           ORDER BY position, title, record_id`,
        )
        .all(input.scope, input.subject ?? '', input.parentId)
      const refusal = docOrderRefusal(
        siblings.map((row) => row.record_id),
        input.orderedIds,
      )
      if (refusal) throw new Error(refusal)
      const client = await hostedDocClient(input.scope, input.subject)
      await client.reorderDocs(input)
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

/**
 * Record the commit a document was checked against, leaving every other field
 * as the stored document has it. `commit` is normalized by the article-field
 * rules, which own its shape and its article-only restriction.
 */
export async function setDocCheckedAgainst(
  scope: string,
  subject: string | null,
  slug: string,
  commit: string,
  context: DocWriteContext,
  owner: string | null = null,
): Promise<Doc> {
  const current = await readDoc(scope, subject, slug, owner)
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
    checkedAgainstCommit: commit,
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
  context: DocRemovalContext,
  owner: string | null = null,
): Promise<boolean> {
  assertWorkerDocStoreWriteAllowed('removeDoc')
  writableDb()
  validScope(scope)
  const identity = resolvedDocWriteIdentity(context)
  const doc = getDoc(scope, subject, slug, owner)
  if (!doc) return false
  return removeStoredDoc(doc, context, identity)
}

/**
 * Consuming a resume changes metadata inside a body whose exact text is the
 * recovery artifact. Patch only the three named fields instead of parsing and
 * serializing YAML, which would rewrite unrelated whitespace and ordering.
 */
export async function consumeDoc(
  scope: string,
  /** Absent resolves the only stored match, as getDoc does. */
  requestedSubject: string | null | undefined,
  slug: string,
  context: DocWriteContext,
  suppliedDoc?: Doc | null,
): Promise<ConsumedDoc> {
  assertWorkerDocStoreWriteAllowed('consumeDoc')
  writableDb()
  validateHistoricDocAddress(scope, slug)
  const identity = resolvedDocWriteIdentity(context)
  const doc = suppliedDoc === undefined ? getDoc(scope, requestedSubject, slug) : suppliedDoc
  if (!doc) throw new Error(`no ${scope} doc "${slug}"`)
  assertLocalStoredReferenceWrite(doc)
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
    { scope, subject: doc.subject, slug: doc.slug, expectedRevision: context.expectedRevision },
    doc.revision,
    false,
  )
  return applyRecordWriteAuthority({
    local: () =>
      executeLocalDocConsume({
        scope,
        subject: doc.subject,
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
          ...hostedDocWriteIdentity(identity),
          expectedRevision: context.expectedRevision,
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await client.consumeDoc(recordId, {
        ...hostedDocWriteIdentity(identity),
        expectedRevision: hostedExpected,
      })
      if (hosted.alreadyConsumed) return { ...doc, already_consumed: true }
      return commitDocConsume({
        scope,
        subject: doc.subject,
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

export type InjectedDoc = Doc & { revision_id: string }

export function docsForRun(input: { job: string; cwd: string }): InjectedDoc[] {
  const project = projectAt(input.cwd)
  const docs = injectedDocsForPack(input.job, project?.name ?? null)
  const latest = db().query(
    'SELECT record_id FROM doc_revision WHERE doc_record_id=? ORDER BY number DESC LIMIT 1',
  )
  return docs.map((doc) => {
    const revisionId = (latest.get(doc.record_id) as { record_id: string } | null)?.record_id
    if (!revisionId) {
      throw new Error(
        `doc ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} has no revision; refusing run`,
      )
    }
    return { ...doc, revision_id: revisionId }
  })
}

export function docsMarkdown(docs: Doc[]): string {
  return joinPackSections(...docs.map(renderPackDocSection))
}

type OpenResume = { slug: string; title: string; age: string; at: number }
type UnreadableResume = {
  slug: string
  reason: 'no-frontmatter' | 'no-readable-status' | 'unrecognized-status'
}
export type OpenResumeList = { open: OpenResume[]; unreadable: UnreadableResume[] }

export async function readOpenResumes(cwd: string, now = Date.now()): Promise<OpenResumeList> {
  const project = projectAt(cwd)
  if (!project) return { open: [], unreadable: [] }
  const open: OpenResume[] = []
  const unreadable: UnreadableResume[] = []
  for (const doc of await readDocs({ scope: 'resume', subject: project.name })) {
    const fm = parseResumeFrontmatter(doc.body)
    if (!fm) unreadable.push({ slug: doc.slug, reason: 'no-frontmatter' })
    else if (!fm.status) unreadable.push({ slug: doc.slug, reason: 'no-readable-status' })
    else if (fm.status !== 'open' && fm.status !== 'consumed')
      unreadable.push({ slug: doc.slug, reason: 'unrecognized-status' })
    else if (fm.status === 'open') {
      const at = rw.resumeTimestampMs(doc.updated_at, doc.created_at)
      open.push({ slug: doc.slug, title: doc.title, age: resumeAge(at, now), at })
    }
  }
  open.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug))
  return { open, unreadable }
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
    const at = rw.resumeTimestampMs(doc.updated_at, doc.created_at)
    open.push({ slug: doc.slug, title: doc.title, age: resumeAge(at, now), at })
  }
  open.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug))
  return { open, unreadable }
}

export function exportDocs(dir: string): number {
  return exportDocFiles(dir, listDocs())
}

export type ImportDocsResult = { count: number; writeWarnings: string[] }

export async function importDocs(dir: string, context: DocWriteContext): Promise<ImportDocsResult> {
  assertWorkerDocStoreWriteAllowed('importDocs')
  writableDb()
  resolvedDocWriteIdentity(context)
  const writeWarnings: string[] = []
  const count = await importDocFiles(dir, async (doc) => {
    const written = await setDocWithOp(
      {
        ...doc,
        ...context,
        expectedRevision: getDoc(doc.scope, doc.subject, doc.slug)?.revision ?? undefined,
      },
      'import',
    )
    writeWarnings.push(...(written.writeWarnings ?? []))
  })
  return { count, writeWarnings }
}

const getDocRevision = getStoredDocRevision

function isAddressRevision(
  revision: DocRevision,
  scope: string,
  subject: string | null,
  owner: string | null,
  slug: string,
) {
  return (
    revision.scope === scope &&
    revision.subject === subject &&
    revision.owner === owner &&
    revision.slug === slug
  )
}

export async function restoreDoc(
  scope: string,
  subject: string | null,
  slug: string,
  revisionId: string,
  context: DocWriteContext & { suppliedRead?: { revision: DocRevision; current: Doc | null } },
  owner: string | null = null,
): Promise<Doc & { writeWarnings?: string[] }> {
  assertWorkerDocStoreWriteAllowed('restoreDoc')
  writableDb()
  validateHistoricDocAddress(scope, slug)
  const identity = resolvedDocWriteIdentity(context)
  const revision = context.suppliedRead?.revision ?? getDocRevision(revisionId, owner)
  if (!revision || !isAddressRevision(revision, scope, subject, owner, slug)) {
    throw new Error(`no revision ${revisionId} for ${scope}/${subject ?? '_'}/${slug}`)
  }
  const [expectedCurrent, current] = context.suppliedRead
    ? [context.suppliedRead.current?.revision ?? null, context.suppliedRead.current]
    : referenceRestoreState(scope, subject, slug, owner, revision)
  assertLocalReferenceRestore(current, revision)
  assertLocalRevisionWrite(
    { scope, subject, slug, expectedRevision: context.expectedRevision },
    expectedCurrent,
    false,
  )
  const canonWarnings = await assertRestoredDocWriteAllowed({
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
      status: revision.status,
      ...localRevisionArticleReferences(revision),
      ...context,
    },
    current,
  )
  const projectName = docWriteProjectName(scope, subject)
  const projectId = projectName ? (projectByName(subject!)?.recordId ?? null) : null
  const restoredParentSlug = localRestoredParentSlug({
    scope,
    subject,
    slug,
    parentId: revision.parent_record_id,
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
    current,
  )
  assertStoredDocBodyCommands(revision, tree.audiences)
  return applyRecordWriteAuthority({
    // A removed local document has no live row retaining its document UUID. Restore mints a
    // new document UUID while its revision history remains continuous by address.
    local: () =>
      executeLocalDocRestore({
        scope,
        subject,
        owner,
        slug,
        liveRecordId: current?.record_id,
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
      let recordId = current?.record_id
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
        recordId = match && typeof match.id === 'string' ? match.id : undefined
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
            parent_record_id: tree.parentId,
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
          ...hostedDocWriteIdentity(identity),
          op: 'restore',
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await client.restoreDoc(recordId, {
        revisionId: revision.record_id ?? recordId,
        ...hostedDocWriteIdentity(identity),
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
  }).then((restored) => addCanonWriteWarnings(restored, canonWarnings))
}
