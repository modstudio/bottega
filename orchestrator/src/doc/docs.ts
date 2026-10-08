/**
 * Operator documents are scoped facts about the installation around this router.
 * Machine, agent, and job facts describe this estate and may be injected. Project
 * and global operator documents are demand-only; software-building instructions are
 * canon. Project, agent, and job facts attach to one named
 * subject; resume briefs attach to a project (the epic is the slug); machine facts
 * describe the host itself. Worker prompts receive job injects; agent and machine
 * notes serve routing and architectural judgment, while resume notes serve session
 * recovery. Canon docs are the source for the global and
 * project hydrated instruction tree and enter worker packs through the canon path.
 */
import {
  DOC_SCOPE_ALLOWS_OWNER,
  DOC_SCOPE_SUBJECT_KIND,
  DOC_SCOPES,
  type DocAudience,
  type DocScope,
  type DocStatus,
} from '../../../shared/docs.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { collectCanonLintInput } from '../canon/canon-files.ts'
import { type CanonRow, composeCanonRows } from '../canon/canon-hydrate.ts'
import { decideUserCanonImport } from '../canon/canon-write-gate.ts'
import { DEFAULT_PACK_BYTES } from '../canon/pack-budget.ts'
import { db, nowIso, writableDb } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { projectAt, projectByName, projects } from '../project/projects.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { workerStoreWriteRefusal } from '../worker-store-write.ts'
import { storedCanonRemovalRefusal } from './canon-removal.ts'
import { exportDocFiles, importDocFiles } from './doc-files.ts'
import { docLintRefusal, introducedDocFindings } from './doc-lint.ts'
import { lintStoredDoc } from './doc-lint-adapter.ts'
import {
  type Doc,
  type DocRevision,
  type DocRevisionMetadata,
  getDocStore,
  listDocMetadataStore,
  listDocsStore,
  type DocListFilters as StoreDocListFilters,
  type DocMetadata as StoreDocMetadata,
} from './doc-read-store.ts'
import { docLifecycle, statusDocWriteInput } from './doc-status.ts'
import { docSubjects, validateHistoricDocAddress, validDocSubjects } from './doc-subjects.ts'
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
export type DocListFilters = StoreDocListFilters
export type DocMetadata = StoreDocMetadata

function assertWorkerDocStoreWriteAllowed(operation: string): void {
  const refusal = workerStoreWriteRefusal('document', operation, process.env)
  if (refusal) throw new Error(refusal)
}

import {
  assertLocalRevisionWrite,
  currentDocRevision,
  docWriteIdentity,
} from './doc-revision-store.ts'
import {
  type CanonWriteTree,
  canonFindingsRefusal,
  consumeDocBody,
  docWriteProjectName,
  forcedDocDelivery,
  globalCanonWriteTargets,
  refuseCanonWrite,
  refuseOversizedInject,
  refuseOwnedDocAddress,
  refuseProjectOrGlobalInject,
  refuseSettingsAddress,
  refuseSettingsBody,
  userCanonWriteTargets,
} from './doc-write-allowed.ts'

export type DocWriteContext = {
  author?: string
  reason: string
  forceInject?: string
  /** A complete preflighted set used only while bootstrapping an empty canon store. */
  canonSet?: CanonRow[]
  allowCanonBootstrap?: boolean
  /** The caller already decided the complete next canon set as one set. */
  canonRemovalDecision?: 'already-decided-next-set'
  expectedRevision?: string
  /** A CLI-selected worktree for project-subject canon validation. */
  canonTree?: CanonWriteTree
}

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
        audience: 'technical',
        featured: false,
        status: 'current',
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
  validateSubject(filter.scope, filter.subject)
}

function validateSubject(scope: DocScope, subject: string): void {
  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  if (subjectKind === null) throw new Error(`${scope} docs take no subject; remove --subject`)
  if (subjectKind === 'project' && !projectByName(subject)) {
    throw new Error(
      `unknown project subject "${subject}"; valid values: ${validDocSubjects(scope)}`,
    )
  }
  if (
    subjectKind === 'stack' &&
    !db().query('SELECT 1 FROM project WHERE stack=? AND retired_at IS NULL LIMIT 1').get(subject)
  ) {
    throw new Error(`unknown stack subject "${subject}"; valid values: ${validDocSubjects(scope)}`)
  }
  if (subjectKind === 'agent' && !AGENTS[subject]) {
    throw new Error(`unknown agent subject "${subject}"; valid values: ${validDocSubjects(scope)}`)
  }
  if (subjectKind === 'job' && !JOBS[subject]) {
    throw new Error(`unknown job subject "${subject}"; valid values: ${validDocSubjects(scope)}`)
  }
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
  validateSubject(scope, subject)
}

export { docSubjects }

export const listDocs = listDocsStore
/** A browsable projection: body contents are fetched only through getDoc. */
export const listDocMetadata = (filters: DocListFilters = {}): DocMetadata[] =>
  listDocMetadataStore(filters)

export const getDoc = getDocStore

export { signedInDocOwner } from './doc-owner.ts'

type DocWriteInput = {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
  title: string
  body: string
  delivery?: 'inject' | 'demand'
  audience?: DocAudience
  parentSlug?: string | null
  position?: number
  featured?: boolean
  status?: DocStatus
  replacementSlug?: string | null
} & DocWriteContext

function ownedCanonWriteFindings(global: CanonRow[], current: CanonRow[], next: CanonRow[]) {
  const surroundings = userCanonWriteTargets(projects()).map((target) => ({
    global,
    project: target ? listDocs({ scope: 'canon', subject: target.name }) : [],
  }))
  return decideUserCanonImport({ current, next, surroundings }).findings
}

function assertOwnedCanonWriteAllowed(input: DocWriteInput & { owner: string }): void {
  const global = listDocs({ scope: 'canon', subject: null })
  const user = listDocs({ scope: 'canon', subject: null, owner: input.owner })
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
  const global = listDocs({ scope: 'canon', subject: null })
  const projectRows = input.subject ? listDocs({ scope: 'canon', subject: input.subject }) : []
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
    const targetProjectRows = listDocs({ scope: 'canon', subject: target.name })
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
    const collected = collectCanonLintInput(root)
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

function assertCanonRemovalAllowed(doc: Doc, tree?: CanonWriteTree): void {
  if (doc.scope !== 'canon') return
  const refusal = storedCanonRemovalRefusal(doc, tree)
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
  collectDocReferenceProjects,
  lintStoredDoc,
  storedDocsHaveRepositoryReferences,
} from './doc-lint-adapter.ts'

function assertDocLint(input: DocWriteInput, prior: Doc | null): void {
  const findings = lintStoredDoc(input as Pick<Doc, 'scope' | 'subject' | 'slug' | 'body'>)
  const introduced = prior ? introducedDocFindings(lintStoredDoc(prior), findings) : findings
  const refusal = docLintRefusal(input, introduced)
  if (refusal) throw new Error(refusal)
}

async function setDocWithOp(input: DocWriteInput, requestedOp?: 'import'): Promise<Doc> {
  writableDb()
  const ownedAddress =
    refuseOwnedDocAddress(input.scope, input.subject, input.owner) ??
    refuseSettingsAddress(input.scope, input.subject, input.owner)
  if (ownedAddress) throw new Error(ownedAddress)
  validate(input.scope, input.subject, input.slug)
  const identity = docWriteIdentity(input)
  const owner = input.owner ?? null
  const prior = getDoc(input.scope, input.subject, input.slug, owner)
  assertLocalRevisionWrite(input, prior?.revision ?? null, prior === null)
  const delivery = forcedDocDelivery(input.scope) ?? input.delivery ?? prior?.delivery ?? 'inject'
  const tree = localDocTreeFields(input, prior)
  const lifecycle = docLifecycle(input, prior, (replacementSlug) =>
    Boolean(getDoc(input.scope, input.subject, replacementSlug, input.owner ?? null)),
  )
  const projectName = docWriteProjectName(input.scope, input.subject)
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
        requestedOp,
        identity,
      }),
    hosted: async () => {
      const hosted = await recordApiClient().upsertDoc({
        scope: input.scope,
        subject: input.subject,
        owner,
        slug: input.slug,
        title: input.title,
        body: input.body,
        delivery,
        audience: tree.audience,
        parentRecordId: localParentRecordId({
          scope: input.scope,
          subject: input.subject,
          owner,
          parent_id: tree.parentId,
          parent_slug: tree.parentSlug,
        }),
        position: tree.position,
        featured: tree.featured,
        status: lifecycle.status,
        replacementSlug: lifecycle.replacementSlug,
        projectName,
        reason: identity.reason,
        author: identity.author,
        forceInject: input.forceInject,
        op: requestedOp ?? (prior ? 'set' : 'create'),
        id: prior?.record_id ?? undefined,
        expectedRevision: input.expectedRevision,
      })
      return commitDocSet({
        ...input,
        owner,
        projectId: projectName ? projectByName(input.subject!)!.id : null,
        delivery,
        ...tree,
        ...lifecycle,
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
  if (!current) throw new Error(`no ${scope} doc "${slug}"; use orch doc list --scope ${scope}`)
  return setDoc({ ...statusDocWriteInput(current, status, replacementSlug), ...context })
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
  const identity = docWriteIdentity(context)
  const doc = getDoc(scope, subject, slug, owner)
  if (!doc) return false
  assertLocalRevisionWrite(
    { scope, expectedRevision: context.expectedRevision },
    doc.revision,
    false,
  )
  if (context.canonRemovalDecision !== 'already-decided-next-set') {
    assertCanonRemovalAllowed(doc, context.canonTree)
  }
  assertLocalDocRemovalAllowed(doc)
  return applyRecordWriteAuthority({
    local: () => executeLocalDocRemove({ scope, subject, owner, slug, doc, identity, ...context }),
    hosted: async () => {
      let recordId = doc.record_id
      let hostedExpected = context.expectedRevision
      if (!recordId) {
        const created = await recordApiClient().upsertDoc({
          scope: doc.scope,
          subject: doc.subject,
          owner: doc.owner,
          slug: doc.slug,
          title: doc.title,
          body: doc.body,
          delivery: doc.delivery,
          audience: doc.audience,
          parentRecordId: localParentRecordId(doc),
          position: doc.position,
          featured: doc.featured,
          reason: identity.reason,
          author: identity.author,
          id: undefined,
          expectedRevision: context.expectedRevision,
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await recordApiClient().deleteDoc(recordId, {
        reason: identity.reason,
        author: identity.author,
        expectedRevision: hostedExpected,
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
  const identity = docWriteIdentity(context)
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
      let recordId = doc.record_id
      let hostedExpected = context.expectedRevision
      if (!recordId) {
        const created = await recordApiClient().upsertDoc({
          scope: doc.scope,
          subject: doc.subject,
          slug: doc.slug,
          title: doc.title,
          body: doc.body,
          delivery: doc.delivery,
          audience: doc.audience,
          parentRecordId: localParentRecordId(doc),
          position: doc.position,
          featured: doc.featured,
          reason: identity.reason,
          author: identity.author,
          expectedRevision: context.expectedRevision,
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await recordApiClient().consumeDoc(recordId, {
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

const RESUME_FRONTMATTER_KEYS = [
  'status',
  'epic',
  'project',
  'written',
  'consumed',
  'consumed_by',
] as const
export type ResumeFrontmatter = { [K in (typeof RESUME_FRONTMATTER_KEYS)[number]]?: string }
type ResolvedStatus = {
  value: string
  valueStart: number
  valueEnd: number
  occurrences: number
}

/**
 * Frontmatter is matched by regex, not parsed as YAML, so consumeDoc can preserve
 * the rest of the recovery artifact byte-for-byte. A column-zero `status:` inside
 * a quoted multi-line scalar is therefore read as a key; adopting a YAML parser is
 * a separate decision. The last column-zero occurrence wins, matching the prior
 * parser behavior and the common YAML-loader treatment of duplicate keys. When
 * there is no column-zero status, the last nested occurrence wins instead.
 */
function resolveStatus(yaml: string): ResolvedStatus | null {
  const topLevel = /(^|\r?\n)(status[ \t]*:[ \t]*)([^\r\n]*)(?=\r?\n|$)/g
  const nested = /(^|\r?\n)([ \t]+status[ \t]*:[ \t]*)([^\r\n]*)(?=\r?\n|$)/g
  const matches = [...yaml.matchAll(topLevel)]
  const governing = matches.length ? matches : [...yaml.matchAll(nested)]
  let resolved: ResolvedStatus | null = null
  let occurrences = 0
  for (const match of governing) {
    occurrences++
    const raw = match[3]!
    const valueStart = match.index! + match[1]!.length + match[2]!.length
    resolved = {
      value: raw.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'),
      valueStart,
      valueEnd: valueStart + raw.length,
      occurrences,
    }
  }
  if (resolved) resolved.occurrences = occurrences
  return resolved
}

/**
 * Status of a resume brief lives in the body's opening YAML, not in the
 * address. An absent block is not open; an unreadable line is skipped rather
 * than making the whole brief disappear.
 */
function resumeFrontmatter(body: string): {
  top: ResumeFrontmatter
  nested: ResumeFrontmatter
  status: ResolvedStatus | null
} | null {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  const top: ResumeFrontmatter = {}
  const nested: ResumeFrontmatter = {}
  const known = new Set<string>(RESUME_FRONTMATTER_KEYS)
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue
    const kv = line.match(/^([ \t]*)([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (!kv) continue
    const key = kv[2]!
    if (!known.has(key)) continue
    let value = kv[3]!
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    const target = kv[1] ? nested : top
    target[key as keyof ResumeFrontmatter] = value
  }
  const status = resolveStatus(match[1]!)
  return { top, nested, status }
}

export function parseResumeFrontmatter(body: string): ResumeFrontmatter | null {
  const parsed = resumeFrontmatter(body)
  if (!parsed) return null
  return {
    ...parsed.nested,
    ...parsed.top,
    ...(parsed.status ? { status: parsed.status.value } : {}),
  }
}

/** Single largest unit: Ns, Nm, Nh, Nd. */
export function resumeAge(fromMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - fromMs)
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
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
  docWriteIdentity(context)
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
  validateHistoricDocAddress(scope, slug)
  return db()
    .query(
      `SELECT id, op, author, reason, at, length(CAST(body AS BLOB)) AS bytes
       FROM doc_revision WHERE scope=? AND subject IS ? AND owner IS ? AND slug=? ORDER BY id DESC`,
    )
    .all(scope, subject, owner, slug) as DocRevisionMetadata[]
}

export function getDocRevision(id: number, owner: string | null = null): DocRevision | null {
  const row = db().query('SELECT * FROM doc_revision WHERE id=? AND owner IS ?').get(id, owner) as
    | (DocRevision & { featured: boolean | number })
    | null
  return row ? { ...row, featured: Boolean(row.featured) } : null
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
  const identity = docWriteIdentity(context)
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
      audience: revision.audience,
      parentSlug: restoredParentSlug,
      position: revision.position,
      featured: revision.featured,
      ...context,
    },
    getDoc(scope, subject, slug, owner),
  )
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
        replacementSlug: revision.replacement_slug,
        identity,
        ...context,
      }),
    hosted: async () => {
      let recordId = liveRecordId
      let hostedExpected = context.expectedRevision
      if (!recordId) {
        const listed = await recordApiClient().listDocs({
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
        const created = await recordApiClient().upsertDoc({
          scope,
          subject,
          owner,
          slug,
          title: revision.title,
          body: revision.body,
          delivery: revision.delivery,
          audience: revision.audience,
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
          replacementSlug: revision.replacement_slug,
          projectName,
          reason: identity.reason,
          author: identity.author,
          op: 'restore',
        })
        recordId = created.id
        hostedExpected = created.revisionId
      }
      const hosted = await recordApiClient().restoreDoc(recordId, {
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
  const left = getDocRevision(a, owner)
  const right = getDocRevision(b, owner)
  if (!left) throw new Error(`no doc revision ${a}`)
  if (!right) throw new Error(`no doc revision ${b}`)
  const x = [
    `status: ${left.status}`,
    `replacement: ${left.replacement_slug ?? '-'}`,
    '',
    ...left.body.split('\n'),
  ]
  const y = [
    `status: ${right.status}`,
    `replacement: ${right.replacement_slug ?? '-'}`,
    '',
    ...right.body.split('\n'),
  ]
  const lengths = Array.from({ length: x.length + 1 }, () =>
    new Array<number>(y.length + 1).fill(0),
  )
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        x[i] === y[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  const lines = [`--- revision-${a}`, `+++ revision-${b}`]
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      lines.push(` ${x[i]}`)
      i++
      j++
    } else if (j < y.length && (i === x.length || lengths[i]![j + 1]! > lengths[i + 1]![j]!)) {
      lines.push(`+${y[j++]}`)
    } else lines.push(`-${x[i++]}`)
  }
  return `${lines.join('\n')}\n`
}
