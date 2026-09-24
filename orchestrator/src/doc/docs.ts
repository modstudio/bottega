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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOC_SCOPE_SUBJECT_KIND, DOC_SCOPES, type DocScope } from '../../../shared/docs.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { collectCanonLintInput } from '../canon/canon-files.ts'
import { type CanonRow, composeCanonRows } from '../canon/canon-hydrate.ts'
import { DEFAULT_PACK_BYTES } from '../canon/pack-budget.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { projectAt, projectByName, projects } from '../project/projects.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { docLintRefusal, introducedDocFindings } from './doc-lint.ts'
import { lintStoredDoc } from './doc-lint-adapter.ts'
import {
  assertLocalRevisionWrite,
  currentDocRevision,
  docWriteIdentity,
  insertLocalRevision,
} from './doc-revision-store.ts'
import {
  consumeDocBody,
  type DocRevisionOp,
  globalCanonWriteTargets,
  importedDocDelivery,
  refuseCanonWrite,
  refuseOversizedInject,
  refuseProjectOrGlobalInject,
} from './doc-write-allowed.ts'

export type Doc = {
  id: number
  scope: DocScope
  subject: string | null
  project_id: number | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  created_at: string
  updated_at: string
  record_id: string | null
  revision: string | null
}

export type DocMetadata = Pick<
  Doc,
  'id' | 'scope' | 'subject' | 'slug' | 'title' | 'updated_at' | 'revision'
> & {
  bytes: number
}

export type DocRevision = {
  id: number
  doc_id: number
  scope: DocScope
  subject: string | null
  project_id: number | null
  slug: string
  op: DocRevisionOp
  title: string
  body: string
  delivery: 'inject' | 'demand'
  author: string
  reason: string
  session_id: string | null
  at: string
  record_id: string | null
}
export type DocRevisionMetadata = Omit<
  DocRevision,
  'title' | 'body' | 'delivery' | 'session_id' | 'doc_id' | 'scope' | 'subject' | 'slug'
> & {
  bytes: number
}
export type DocWriteContext = {
  author?: string
  reason: string
  forceInject?: string
  /** A complete preflighted set used only while bootstrapping an empty canon store. */
  canonSet?: CanonRow[]
  allowCanonBootstrap?: boolean
  expectedRevision?: string
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
        slug: input.slug,
        title: input.title,
        body: input.body,
        delivery: 'inject',
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

export type DocListFilters = {
  scope?: string
  subject?: string | null
  scopes?: string[]
  match?: string
  bodyMatch?: string
  updatedAtOrder?: 'asc' | 'desc'
}

const LATEST_REVISION_SQL =
  '(SELECT r.record_id FROM doc_revision r WHERE r.doc_id=d.id ORDER BY r.id DESC LIMIT 1)'

function validScope(scope: string): asserts scope is DocScope {
  if (!DOC_SCOPES.includes(scope as DocScope)) {
    throw new Error(`unknown doc scope "${scope}"; valid scopes: ${DOC_SCOPES.join(', ')}`)
  }
}

function validateHistoricAddress(scope: string, slug: string): asserts scope is DocScope {
  validScope(scope)
  if (scope === 'canon') {
    if (!slug || slug.startsWith('/') || slug.includes('..')) {
      throw new Error('invalid canon slug; use a repository-relative canon mirror path')
    }
    return
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length > 64) {
    throw new Error(
      'invalid slug; use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit',
    )
  }
}

function validate(scope: string, subject: string | null, slug: string): asserts scope is DocScope {
  validateHistoricAddress(scope, slug)
  if (scope === 'canon' && subject === null) return
  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  if (subjectKind === null) {
    if (subject !== null) throw new Error(`${scope} docs take no subject; remove --subject`)
    return
  }
  if (!subject)
    throw new Error(`${scope} docs require --subject; valid values: ${validSubjects(scope)}`)
  if (subjectKind === 'project' && !projectByName(subject)) {
    throw new Error(`unknown project subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
  if (
    subjectKind === 'stack' &&
    !db().query('SELECT 1 FROM project WHERE stack=? AND retired_at IS NULL LIMIT 1').get(subject)
  ) {
    throw new Error(`unknown stack subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
  if (subjectKind === 'agent' && !AGENTS[subject]) {
    throw new Error(`unknown agent subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
  if (subjectKind === 'job' && !JOBS[subject]) {
    throw new Error(`unknown job subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
}

export function docSubjects(): {
  project: string[]
  stack: string[]
  agent: string[]
  job: string[]
} {
  return {
    project: (db().query('SELECT name FROM project ORDER BY name').all() as { name: string }[]).map(
      (r) => r.name,
    ),
    stack: (
      db()
        .query('SELECT DISTINCT stack FROM project WHERE stack IS NOT NULL ORDER BY stack')
        .all() as { stack: string }[]
    ).map((r) => r.stack),
    agent: Object.keys(AGENTS).sort(),
    job: Object.keys(JOBS).sort(),
  }
}

function validSubjects(scope: DocScope): string {
  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  if (subjectKind === null) return '(none)'
  const values =
    subjectKind === 'project'
      ? (db().query('SELECT name FROM project ORDER BY name').all() as { name: string }[]).map(
          (r) => r.name,
        )
      : subjectKind === 'stack'
        ? (
            db()
              .query('SELECT DISTINCT stack FROM project WHERE stack IS NOT NULL ORDER BY stack')
              .all() as { stack: string }[]
          ).map((r) => r.stack)
        : Object.keys(subjectKind === 'agent' ? AGENTS : JOBS).sort()
  return values.join(', ') || '(none)'
}

export function listDocs(filters: { scope?: string; subject?: string | null } = {}): Doc[] {
  if (filters.scope !== undefined) validScope(filters.scope)
  const where: string[] = []
  const values: string[] = []
  if (filters.scope !== undefined) {
    where.push('scope = ?')
    values.push(filters.scope)
  }
  if (filters.subject !== undefined) {
    where.push(filters.subject === null ? 'subject IS NULL' : 'subject = ?')
    if (filters.subject !== null) values.push(filters.subject)
  }
  return db()
    .query(
      `SELECT d.*, ${LATEST_REVISION_SQL} AS revision FROM doc d${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
        "ORDER BY scope, COALESCE(subject, ''), slug",
    )
    .all(...values) as Doc[]
}

/** A browsable projection: body contents are fetched only through getDoc. */
export function listDocMetadata(filters: DocListFilters = {}): DocMetadata[] {
  if (filters.scope !== undefined) validScope(filters.scope)
  if (filters.scopes !== undefined) {
    for (const scope of filters.scopes) validScope(scope)
  }
  if (filters.scope !== undefined && filters.scopes !== undefined) {
    throw new Error('use scope or scopes, not both')
  }

  const where: string[] = []
  const values: string[] = []
  if (filters.scope !== undefined) {
    where.push('scope = ?')
    values.push(filters.scope)
  }
  if (filters.scopes !== undefined) {
    if (filters.scopes.length === 0) where.push('0')
    else {
      where.push(`scope IN (${filters.scopes.map(() => '?').join(', ')})`)
      values.push(...filters.scopes)
    }
  }
  if (filters.subject !== undefined) {
    where.push(filters.subject === null ? 'subject IS NULL' : 'subject = ?')
    if (filters.subject !== null) values.push(filters.subject)
  }
  if (filters.match !== undefined) {
    where.push(`(
      instr(lower(title), lower(?)) > 0 OR
      instr(lower(slug), lower(?)) > 0 OR
      instr(lower(COALESCE(subject, '')), lower(?)) > 0
    )`)
    values.push(filters.match, filters.match, filters.match)
  }
  if (filters.bodyMatch !== undefined) {
    where.push('instr(lower(body), lower(?)) > 0')
    values.push(filters.bodyMatch)
  }

  const order = filters.updatedAtOrder
    ? `updated_at ${filters.updatedAtOrder.toUpperCase()}, scope, COALESCE(subject, ''), slug`
    : "scope, COALESCE(subject, ''), slug"
  return db()
    .query(
      `SELECT d.id, d.scope, d.subject, d.slug, d.title, length(CAST(d.body AS BLOB)) AS bytes, d.updated_at, ${LATEST_REVISION_SQL} AS revision
       FROM doc d${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
    )
    .all(...values) as DocMetadata[]
}

export function getDoc(scope: string, subject: string | null, slug: string): Doc | null {
  validScope(scope)
  return db()
    .query(
      `SELECT d.*, ${LATEST_REVISION_SQL} AS revision FROM doc d WHERE scope = ? AND subject IS ? AND slug = ?`,
    )
    .get(scope, subject, slug) as Doc | null
}

type DocWriteInput = {
  scope: string
  subject: string | null
  slug: string
  title: string
  body: string
  delivery?: 'inject' | 'demand'
} & DocWriteContext

function assertCanonWriteAllowed(input: DocWriteInput): void {
  if (input.scope !== 'canon') return
  const project = input.subject ? projectByName(input.subject)! : null
  const global = listDocs({ scope: 'canon', subject: null })
  const projectRows = input.subject ? listDocs({ scope: 'canon', subject: input.subject }) : []
  const changedRows = input.canonSet ?? [
    ...(project ? projectRows : global).filter(({ slug }) => slug !== input.slug),
    { slug: input.slug, body: input.body },
  ]
  const next = composeCanonRows(
    (project ? global : changedRows).map((row) => ({ ...row, subject: null })),
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
    const targetCurrent = composeCanonRows(global, targetProjectRows).map(({ slug, body }) => ({
      slug,
      body,
    }))
    const targetNext = project
      ? next
      : composeCanonRows(
          changedRows.map((row) => ({ ...row, subject: null })),
          targetProjectRows,
        ).map(({ slug, body }) => ({ slug, body }))
    const collected = collectCanonLintInput(target.path)
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

function assertDocWriteAllowed(input: DocWriteInput & { delivery: 'inject' | 'demand' }): void {
  const inject = refuseProjectOrGlobalInject(input.scope, input.delivery)
  if (inject) throw new Error(inject)
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
  validate(input.scope, input.subject, input.slug)
  const identity = docWriteIdentity(input)
  const prior = getDoc(input.scope, input.subject, input.slug)
  assertLocalRevisionWrite(input, prior?.revision ?? null, prior === null)
  const delivery =
    input.scope === 'canon' ? 'demand' : (input.delivery ?? prior?.delivery ?? 'inject')
  assertDocWriteAllowed({ ...input, delivery })
  assertDocLint(input, prior)
  const hosted = await recordApiClient().upsertDoc({
    scope: input.scope,
    subject: input.subject,
    slug: input.slug,
    title: input.title,
    body: input.body,
    delivery,
    projectName:
      input.scope === 'project' || (input.scope === 'canon' && input.subject)
        ? input.subject
        : null,
    reason: identity.reason,
    author: identity.author,
    forceInject: input.forceInject,
    op: requestedOp ?? (prior ? 'set' : 'create'),
    id: prior?.record_id ?? undefined,
    expectedRevision: input.expectedRevision,
  })
  return writeTransaction(() => {
    const existing = getDoc(input.scope, input.subject, input.slug)
    assertLocalRevisionWrite(input, existing?.revision ?? null, existing === null)
    const at = nowIso()
    let doc: Doc
    if (existing) {
      db()
        .query('UPDATE doc SET title=?, body=?, delivery=?, updated_at=?, record_id=? WHERE id=?')
        .run(
          input.title,
          input.body,
          input.scope === 'canon' ? 'demand' : (input.delivery ?? existing.delivery),
          at,
          hosted.id,
          existing.id,
        )
      doc = getDoc(input.scope, input.subject, input.slug)!
    } else {
      db()
        .query(
          `INSERT INTO doc (scope, subject, project_id, slug, title, body, delivery, created_at, updated_at, record_id)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        )
        .get(
          input.scope,
          input.subject,
          input.scope === 'project' || (input.scope === 'canon' && input.subject)
            ? projectByName(input.subject!)!.id
            : null,
          input.slug,
          input.title,
          input.body,
          input.scope === 'canon' ? 'demand' : (input.delivery ?? 'inject'),
          at,
          at,
          hosted.id,
        )
      doc = getDoc(input.scope, input.subject, input.slug)!
    }
    insertLocalRevision(
      doc,
      requestedOp ?? (existing ? 'set' : 'create'),
      identity,
      at,
      hosted.revisionId,
    )
    return getDoc(input.scope, input.subject, input.slug)!
  })
}

export async function setDoc(
  input: {
    scope: string
    subject: string | null
    slug: string
    title: string
    body: string
    delivery?: 'inject' | 'demand'
  } & DocWriteContext,
): Promise<Doc> {
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
  return setDocWithOp(input, 'import')
}

export async function removeDoc(
  scope: string,
  subject: string | null,
  slug: string,
  context: DocWriteContext,
): Promise<boolean> {
  writableDb()
  validScope(scope)
  const identity = docWriteIdentity(context)
  const doc = getDoc(scope, subject, slug)
  if (!doc) return false
  assertLocalRevisionWrite(
    { scope, expectedRevision: context.expectedRevision },
    doc.revision,
    false,
  )
  let recordId = doc.record_id
  let hostedExpected = context.expectedRevision
  if (!recordId) {
    const hosted = await recordApiClient().upsertDoc({
      scope: doc.scope,
      subject: doc.subject,
      slug: doc.slug,
      title: doc.title,
      body: doc.body,
      delivery: doc.delivery,
      reason: identity.reason,
      author: identity.author,
      id: undefined,
      expectedRevision: context.expectedRevision,
    })
    recordId = hosted.id
    hostedExpected = hosted.revisionId
  }
  const hosted = await recordApiClient().deleteDoc(recordId, {
    reason: identity.reason,
    author: identity.author,
    expectedRevision: hostedExpected,
  })
  return writeTransaction(() => {
    const existing = getDoc(scope, subject, slug)
    if (!existing) throw new Error(`no ${scope} doc "${slug}"`)
    assertLocalRevisionWrite(
      { scope, expectedRevision: context.expectedRevision },
      existing.revision,
      false,
    )
    const at = nowIso()
    db().query('DELETE FROM doc WHERE id=?').run(existing.id)
    insertLocalRevision(existing, 'delete', identity, at, hosted.revisionId)
    return true
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
  writableDb()
  validateHistoricAddress(scope, slug)
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
  return writeTransaction(() => {
    const existing = getDoc(scope, subject, slug)
    if (!existing) throw new Error(`no ${scope} doc "${slug}"`)
    assertLocalRevisionWrite(
      { scope, expectedRevision: context.expectedRevision },
      existing.revision,
      false,
    )
    db()
      .query('UPDATE doc SET body=?, updated_at=?, record_id=? WHERE id=?')
      .run(patched.body, consumedAt, recordId, existing.id)
    const result = getDoc(scope, subject, slug)!
    insertLocalRevision(result, 'consume', identity, consumedAt, hosted.revisionId)
    return { ...getDoc(scope, subject, slug)!, already_consumed: false }
  })
}

export type InjectedDoc = Doc & { revision_id: number }

export function docsForRun(input: { job: string; cwd: string }): InjectedDoc[] {
  const project = projectAt(input.cwd)
  const docs = [
    ...listDocs({ scope: 'global', subject: null }),
    ...listDocs({ scope: 'job', subject: input.job }),
    ...(project ? listDocs({ scope: 'project', subject: project.name }) : []),
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

function resumeTimestampMs(written: string | undefined, createdAt: string): number {
  if (written) {
    const parsed = Date.parse(written)
    if (!Number.isNaN(parsed)) return parsed
  }
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
    const at = resumeTimestampMs(fm.written, doc.created_at)
    open.push({ slug: doc.slug, title: doc.title, age: resumeAge(at, now), at })
  }
  open.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug))
  return { open, unreadable }
}

export function exportDocs(dir: string): number {
  const docs = listDocs()
  for (const doc of docs) {
    const target = join(dir, doc.scope, doc.subject ?? '_')
    mkdirSync(target, { recursive: true })
    writeFileSync(
      join(target, `${doc.slug}.md`),
      `---\ntitle: ${JSON.stringify(doc.title)}\n---\n\n${doc.body}`,
    )
  }
  return docs.length
}

function importedDoc(path: string, fileName: string): { title: string; body: string } {
  const raw = readFileSync(path, 'utf8')
  const match = raw.match(/^---\r?\ntitle:\s*(.+)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/)
  if (!match) throw new Error(`${fileName}: expected YAML frontmatter with a title`)
  let title: unknown
  try {
    title = JSON.parse(match[1]!)
  } catch {
    throw new Error(`${fileName}: title must be a YAML double-quoted string`)
  }
  if (typeof title !== 'string') throw new Error(`${fileName}: title must be a string`)
  return { title, body: match[2]! }
}

export async function importDocs(dir: string, context: DocWriteContext): Promise<number> {
  writableDb()
  docWriteIdentity(context)
  let count = 0
  for (const scopeEntry of readdirSync(dir, { withFileTypes: true })) {
    if (!scopeEntry.isDirectory()) continue
    validScope(scopeEntry.name)
    const scope = scopeEntry.name
    for (const subjectEntry of readdirSync(join(dir, scope), { withFileTypes: true })) {
      if (!subjectEntry.isDirectory()) continue
      const subject = subjectEntry.name === '_' ? null : subjectEntry.name
      for (const file of readdirSync(join(dir, scope, subjectEntry.name), {
        withFileTypes: true,
      })) {
        if (!file.isFile() || !file.name.endsWith('.md')) continue
        const parsed = importedDoc(join(dir, scope, subjectEntry.name, file.name), file.name)
        await setDocWithOp(
          {
            scope,
            subject,
            slug: file.name.slice(0, -3),
            ...parsed,
            delivery: importedDocDelivery(scope),
            ...context,
            expectedRevision: getDoc(scope, subject, file.name.slice(0, -3))?.revision ?? undefined,
          },
          'import',
        )
        count++
      }
    }
  }
  return count
}

export function listDocRevisions(
  scope: string,
  subject: string | null,
  slug: string,
): DocRevisionMetadata[] {
  validateHistoricAddress(scope, slug)
  return db()
    .query(
      `SELECT id, op, author, reason, at, length(CAST(body AS BLOB)) AS bytes
       FROM doc_revision WHERE scope=? AND subject IS ? AND slug=? ORDER BY id DESC`,
    )
    .all(scope, subject, slug) as DocRevisionMetadata[]
}

export function getDocRevision(id: number): DocRevision | null {
  return db().query('SELECT * FROM doc_revision WHERE id=?').get(id) as DocRevision | null
}

export async function restoreDoc(
  scope: string,
  subject: string | null,
  slug: string,
  revisionId: number,
  context: DocWriteContext,
): Promise<Doc> {
  writableDb()
  validateHistoricAddress(scope, slug)
  const identity = docWriteIdentity(context)
  const revision = getDocRevision(revisionId)
  if (
    !revision ||
    revision.scope !== scope ||
    revision.subject !== subject ||
    revision.slug !== slug
  ) {
    throw new Error(`no revision ${revisionId} for ${scope}/${subject ?? '_'}/${slug}`)
  }
  const expectedCurrent = currentDocRevision(scope, subject, slug)
  assertLocalRevisionWrite(
    { scope, expectedRevision: context.expectedRevision },
    expectedCurrent,
    false,
  )
  assertDocWriteAllowed({
    scope,
    subject,
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
      slug,
      title: revision.title,
      body: revision.body,
      delivery: revision.delivery,
      ...context,
    },
    null,
  )
  let recordId = getDoc(scope, subject, slug)?.record_id
  let hostedExpected = context.expectedRevision
  if (!recordId) {
    const listed = await recordApiClient().listDocs({
      scope,
      subject,
      includeDeleted: true,
      limit: 100,
    })
    const match = listed.items.find(
      (row) => String(row.slug) === slug && (row.subject ?? null) === subject,
    )
    recordId = match && typeof match.id === 'string' ? match.id : null
  }
  if (!recordId) {
    const created = await recordApiClient().upsertDoc({
      scope,
      subject,
      slug,
      title: revision.title,
      body: revision.body,
      delivery: revision.delivery,
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
  return writeTransaction(() => {
    assertLocalRevisionWrite(
      { scope, expectedRevision: context.expectedRevision },
      currentDocRevision(scope, subject, slug),
      false,
    )
    const existing = getDoc(scope, subject, slug)
    const at = nowIso()
    let doc: Doc
    if (existing) {
      db()
        .query('UPDATE doc SET title=?, body=?, delivery=?, updated_at=?, record_id=? WHERE id=?')
        .run(revision.title, revision.body, revision.delivery, at, hosted.id, existing.id)
      doc = getDoc(scope, subject, slug)!
    } else {
      db()
        .query(
          `INSERT INTO doc (scope, subject, project_id, slug, title, body, delivery, created_at, updated_at, record_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          scope,
          subject,
          scope === 'project' ? (projectByName(subject!)?.id ?? null) : null,
          slug,
          revision.title,
          revision.body,
          revision.delivery,
          at,
          at,
          hosted.id,
        )
      doc = getDoc(scope, subject, slug)!
    }
    insertLocalRevision(doc, 'restore', identity, at, hosted.revisionId)
    return getDoc(scope, subject, slug)!
  })
}

export function diffDocRevisions(a: number, b: number): string {
  const left = getDocRevision(a)
  const right = getDocRevision(b)
  if (!left) throw new Error(`no doc revision ${a}`)
  if (!right) throw new Error(`no doc revision ${b}`)
  const x = left.body.split('\n')
  const y = right.body.split('\n')
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
