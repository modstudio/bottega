/**
 * Operator documents are scoped facts about the installation around this router.
 * Global facts apply everywhere; project, agent, and job facts attach to one named
 * subject; resume briefs attach to a project (the epic is the slug); machine facts
 * describe the host itself. Worker prompts receive only global, job, and
 * current-project documents; agent, machine, and resume notes serve routing and
 * architectural judgement instead. If an adopter needs text unchanged,
 * it is canon in the repository; if it describes this estate, it belongs here.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOC_SCOPES, DOC_SCOPE_SUBJECT_KIND, type DocScope,
} from '../../shared/docs.ts'
import { AGENTS } from './agents.ts'
import { db, nowIso, sessionId } from './db.ts'
import { JOBS } from './jobs.ts'
import { projectAt, projectByName } from './projects.ts'

export { DOC_SCOPES, type DocScope }

export type Doc = {
  id: number
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  body: string
  created_at: string
  updated_at: string
}

export type DocMetadata = Pick<Doc, 'id' | 'scope' | 'subject' | 'slug' | 'title' | 'updated_at'> & {
  bytes: number
}

export type DocRevisionOp = 'create' | 'set' | 'consume' | 'delete' | 'restore' | 'import' | 'backfill'
export type DocRevision = {
  id: number
  doc_id: number
  scope: DocScope
  subject: string | null
  slug: string
  op: DocRevisionOp
  title: string
  body: string
  author: string
  reason: string
  session_id: string | null
  at: string
}
export type DocRevisionMetadata = Omit<DocRevision, 'title' | 'body' | 'session_id' | 'doc_id' | 'scope' | 'subject' | 'slug'> & {
  bytes: number
}
export type DocWriteContext = { author?: string; reason: string }

export type DocListFilters = {
  scope?: string
  subject?: string | null
  scopes?: string[]
  match?: string
  bodyMatch?: string
  updatedAtOrder?: 'asc' | 'desc'
}

function validScope(scope: string): asserts scope is DocScope {
  if (!DOC_SCOPES.includes(scope as DocScope)) {
    throw new Error(`unknown doc scope "${scope}"; valid scopes: ${DOC_SCOPES.join(', ')}`)
  }
}

function validateHistoricAddress(scope: string, slug: string): asserts scope is DocScope {
  validScope(scope)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length > 64) {
    throw new Error('invalid slug; use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit')
  }
}

function validate(scope: string, subject: string | null, slug: string): asserts scope is DocScope {
  validateHistoricAddress(scope, slug)
  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  if (subjectKind === null) {
    if (subject !== null) throw new Error(`${scope} docs take no subject; remove --subject`)
    return
  }
  if (!subject) throw new Error(`${scope} docs require --subject; valid values: ${validSubjects(scope)}`)
  if (subjectKind === 'project' && !projectByName(subject)) {
    throw new Error(`unknown project subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
  if (subjectKind === 'agent' && !AGENTS[subject]) {
    throw new Error(`unknown agent subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
  if (subjectKind === 'job' && !JOBS[subject]) {
    throw new Error(`unknown job subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
}

export function docSubjects(): { project: string[]; agent: string[]; job: string[] } {
  return {
    project: db().query('SELECT name FROM project ORDER BY name').all().map((r: any) => r.name),
    agent: Object.keys(AGENTS).sort(),
    job: Object.keys(JOBS).sort(),
  }
}

function validSubjects(scope: DocScope): string {
  const subjectKind = DOC_SCOPE_SUBJECT_KIND[scope]
  if (subjectKind === null) return '(none)'
  const values = subjectKind === 'project'
    ? db().query('SELECT name FROM project ORDER BY name').all().map((r: any) => r.name)
    : Object.keys(subjectKind === 'agent' ? AGENTS : JOBS).sort()
  return values.join(', ') || '(none)'
}

export function listDocs(filters: { scope?: string; subject?: string | null } = {}): Doc[] {
  if (filters.scope !== undefined) validScope(filters.scope)
  const where: string[] = []
  const values: any[] = []
  if (filters.scope !== undefined) { where.push('scope = ?'); values.push(filters.scope) }
  if (filters.subject !== undefined) {
    where.push(filters.subject === null ? 'subject IS NULL' : 'subject = ?')
    if (filters.subject !== null) values.push(filters.subject)
  }
  return db().query(
    `SELECT * FROM doc${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
    'ORDER BY scope, COALESCE(subject, \'\'), slug',
  ).all(...values) as Doc[]
}

/** A browseable projection: body contents are fetched only through getDoc. */
export function listDocMetadata(filters: DocListFilters = {}): DocMetadata[] {
  if (filters.scope !== undefined) validScope(filters.scope)
  if (filters.scopes !== undefined) {
    for (const scope of filters.scopes) validScope(scope)
  }
  if (filters.scope !== undefined && filters.scopes !== undefined) {
    throw new Error('use scope or scopes, not both')
  }

  const where: string[] = []
  const values: any[] = []
  if (filters.scope !== undefined) { where.push('scope = ?'); values.push(filters.scope) }
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
  return db().query(
    `SELECT id, scope, subject, slug, title, length(CAST(body AS BLOB)) AS bytes, updated_at
     FROM doc${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
  ).all(...values) as DocMetadata[]
}

export function getDoc(scope: string, subject: string | null, slug: string): Doc | null {
  validScope(scope)
  return db().query(
    'SELECT * FROM doc WHERE scope = ? AND subject IS ? AND slug = ?',
  ).get(scope, subject, slug) as Doc | null
}

function writeIdentity(context: DocWriteContext): { author: string; reason: string; session: string | null } {
  const reason = context.reason?.trim()
  if (!reason) throw new Error('doc write reason is required; pass --reason on the CLI or reason through MCP/Hub')
  const session = sessionId()
  const author = (context.author ?? session ?? 'unknown').trim()
  if (!author) throw new Error('doc write author must not be empty; omit it to use the session or unknown')
  return { author, reason, session }
}

function insertRevision(doc: Doc, op: DocRevisionOp, context: DocWriteContext, at: string): void {
  const identity = writeIdentity(context)
  db().query(
    `INSERT INTO doc_revision
       (doc_id, scope, subject, slug, op, title, body, author, reason, session_id, at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    doc.id, doc.scope, doc.subject, doc.slug, op, doc.title, doc.body,
    identity.author, identity.reason, identity.session, at,
  )
}

function setDocWithOp(input: {
  scope: string; subject: string | null; slug: string; title: string; body: string
} & DocWriteContext, requestedOp?: 'import'): Doc {
  validate(input.scope, input.subject, input.slug)
  writeIdentity(input)
  return db().transaction(() => {
    const existing = getDoc(input.scope, input.subject, input.slug)
    const at = nowIso()
    let doc: Doc
    if (existing) {
      db().query('UPDATE doc SET title=?, body=?, updated_at=? WHERE id=?')
        .run(input.title, input.body, at, existing.id)
      doc = getDoc(input.scope, input.subject, input.slug)!
    } else {
      const id = (db().query(
        `INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?) RETURNING id`,
      ).get(input.scope, input.subject, input.slug, input.title, input.body, at, at) as { id: number }).id
      doc = db().query('SELECT * FROM doc WHERE id=?').get(id) as Doc
    }
    insertRevision(doc, requestedOp ?? (existing ? 'set' : 'create'), input, at)
    return doc
  })()
}

export function setDoc(input: {
  scope: string; subject: string | null; slug: string; title: string; body: string
} & DocWriteContext): Doc {
  return setDocWithOp(input)
}

export function importDoc(input: {
  scope: string; subject: string | null; slug: string; title: string; body: string
} & DocWriteContext): Doc {
  return setDocWithOp(input, 'import')
}

export function removeDoc(
  scope: string, subject: string | null, slug: string, context: DocWriteContext,
): boolean {
  validScope(scope)
  writeIdentity(context)
  return db().transaction(() => {
    const doc = getDoc(scope, subject, slug)
    if (!doc) return false
    const at = nowIso()
    db().query('DELETE FROM doc WHERE id=?').run(doc.id)
    insertRevision(doc, 'delete', context, at)
    return true
  })()
}

export type ConsumedDoc = Doc & { already_consumed: boolean }

/**
 * Consuming a resume changes metadata inside a body whose exact text is the
 * recovery artifact. Patch only the three named fields instead of parsing and
 * serializing YAML, which would rewrite unrelated whitespace and ordering.
 */
export function consumeDoc(
  scope: string, subject: string | null, slug: string,
  context: DocWriteContext,
): ConsumedDoc {
  validate(scope, subject, slug)
  writeIdentity(context)
  const doc = getDoc(scope, subject, slug)
  if (!doc) throw new Error(`no ${scope} doc "${slug}"`)

  const frontmatter = doc.body.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/)
  if (!frontmatter) throw new Error(`${scope} doc "${slug}" has no YAML frontmatter`)
  const newline = frontmatter[1]!
  let yaml = frontmatter[2]!
  const field = (name: string) =>
    new RegExp(`(^|\\r?\\n)([ \\t]*${name}[ \\t]*:[ \\t]*)([^\\r\\n]*)(?=\\r?\\n|$)`, 'm')
  const status = yaml.match(field('status'))
  if (!status) throw new Error(`${scope} doc "${slug}" has no status field in its YAML frontmatter`)
  const statusValue = status[3]!.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
  if (statusValue === 'consumed') return { ...doc, already_consumed: true }

  yaml = yaml.replace(field('status'), `$1$2consumed`)
  const consumedAt = nowIso()
  const stamps = [
    ['consumed', consumedAt],
    ['consumed_by', sessionId() ?? 'unknown'],
  ] as const
  const missing: string[] = []
  for (const [name, value] of stamps) {
    const pattern = field(name)
    if (pattern.test(yaml)) yaml = yaml.replace(pattern, `$1$2${value}`)
    else missing.push(`${name}: ${value}`)
  }
  if (missing.length) {
    yaml = yaml.replace(field('status'), `$1$2$3${newline}${missing.join(newline)}`)
  }

  const contentStart = frontmatter.index! + 3 + newline.length
  const body = doc.body.slice(0, contentStart) + yaml
    + doc.body.slice(contentStart + frontmatter[2]!.length)
  return db().transaction(() => {
    db().query('UPDATE doc SET body=?, updated_at=? WHERE id=?').run(body, consumedAt, doc.id)
    const result = getDoc(scope, subject, slug)!
    insertRevision(result, 'consume', context, consumedAt)
    return { ...result, already_consumed: false }
  })()
}

export type InjectedDoc = Doc & { revision_id: number }

export function docsForRun(input: { job: string; cwd: string }): InjectedDoc[] {
  const project = projectAt(input.cwd)
  const docs = [
    ...listDocs({ scope: 'global', subject: null }),
    ...listDocs({ scope: 'job', subject: input.job }),
    ...(project ? listDocs({ scope: 'project', subject: project.name }) : []),
  ]
  const latest = db().query('SELECT MAX(id) AS id FROM doc_revision WHERE doc_id=?')
  return docs.map((doc) => {
    const revisionId = (latest.get(doc.id) as { id: number | null }).id
    if (revisionId === null) {
      throw new Error(`doc ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} has no revision; refusing run`)
    }
    return { ...doc, revision_id: revisionId }
  })
}

export function docsMarkdown(docs: Doc[]): string {
  return docs.map((doc) => `## ${doc.title}\n\n${doc.body}`).join('\n\n')
}

export function brief(cwd: string): string {
  const project = projectAt(cwd)
  return docsMarkdown([
    ...listDocs({ scope: 'global', subject: null }),
    ...(project ? listDocs({ scope: 'project', subject: project.name }) : []),
  ])
}

const RESUME_FRONTMATTER_KEYS = ['status', 'epic', 'project', 'written', 'consumed', 'consumed_by'] as const
export type ResumeFrontmatter = { [K in typeof RESUME_FRONTMATTER_KEYS[number]]?: string }

/**
 * Status of a resume brief lives in the body's opening YAML, not in the
 * address. A missing or unreadable block is not open.
 */
export function parseResumeFrontmatter(body: string): ResumeFrontmatter | null {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  const out: ResumeFrontmatter = {}
  const known = new Set<string>(RESUME_FRONTMATTER_KEYS)
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (!kv) return null
    const key = kv[1]!
    if (!known.has(key)) continue
    let value = kv[2]!
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    out[key as keyof ResumeFrontmatter] = value
  }
  return out
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

export type OpenResume = { slug: string; title: string; age: string; at: number }

function resumeTimestampMs(written: string | undefined, createdAt: string): number {
  if (written) {
    const parsed = Date.parse(written)
    if (!Number.isNaN(parsed)) return parsed
  }
  const fallback = Date.parse(createdAt)
  return Number.isNaN(fallback) ? 0 : fallback
}

export function listOpenResumes(cwd: string, now = Date.now()): OpenResume[] {
  const project = projectAt(cwd)
  if (!project) return []
  const open: OpenResume[] = []
  for (const doc of listDocs({ scope: 'resume', subject: project.name })) {
    const fm = parseResumeFrontmatter(doc.body)
    if (!fm || fm.status !== 'open') continue
    const at = resumeTimestampMs(fm.written, doc.created_at)
    open.push({ slug: doc.slug, title: doc.title, age: resumeAge(at, now), at })
  }
  open.sort((a, b) => b.at - a.at || a.slug.localeCompare(b.slug))
  return open
}

export function exportDocs(dir: string): number {
  const docs = listDocs()
  for (const doc of docs) {
    const target = join(dir, doc.scope, doc.subject ?? '_')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, `${doc.slug}.md`), `---\ntitle: ${JSON.stringify(doc.title)}\n---\n\n${doc.body}`)
  }
  return docs.length
}

export function importDocs(dir: string, context: DocWriteContext): number {
  writeIdentity(context)
  let count = 0
  for (const scopeEntry of readdirSync(dir, { withFileTypes: true })) {
    if (!scopeEntry.isDirectory()) continue
    validScope(scopeEntry.name)
    const scope = scopeEntry.name
    for (const subjectEntry of readdirSync(join(dir, scope), { withFileTypes: true })) {
      if (!subjectEntry.isDirectory()) continue
      const subject = subjectEntry.name === '_' ? null : subjectEntry.name
      for (const file of readdirSync(join(dir, scope, subjectEntry.name), { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.md')) continue
        const raw = readFileSync(join(dir, scope, subjectEntry.name, file.name), 'utf8')
        const match = raw.match(/^---\r?\ntitle:\s*(.+)\r?\n---\r?\n(?:\r?\n)?([\s\S]*)$/)
        if (!match) throw new Error(`${file.name}: expected YAML frontmatter with a title`)
        let title: string
        try { title = JSON.parse(match[1]!) }
        catch { throw new Error(`${file.name}: title must be a YAML double-quoted string`) }
        if (typeof title !== 'string') throw new Error(`${file.name}: title must be a string`)
        setDocWithOp({ scope, subject, slug: file.name.slice(0, -3), title, body: match[2]!, ...context }, 'import')
        count++
      }
    }
  }
  return count
}

export function listDocRevisions(scope: string, subject: string | null, slug: string): DocRevisionMetadata[] {
  validateHistoricAddress(scope, slug)
  return db().query(
    `SELECT id, op, author, reason, at, length(CAST(body AS BLOB)) AS bytes
       FROM doc_revision WHERE scope=? AND subject IS ? AND slug=? ORDER BY id DESC`,
  ).all(scope, subject, slug) as DocRevisionMetadata[]
}

export function getDocRevision(id: number): DocRevision | null {
  return db().query('SELECT * FROM doc_revision WHERE id=?').get(id) as DocRevision | null
}

export function restoreDoc(
  scope: string, subject: string | null, slug: string, revisionId: number, context: DocWriteContext,
): Doc {
  validateHistoricAddress(scope, slug)
  writeIdentity(context)
  const revision = getDocRevision(revisionId)
  if (!revision || revision.scope !== scope || revision.subject !== subject || revision.slug !== slug) {
    throw new Error(`no revision ${revisionId} for ${scope}/${subject ?? '_'}/${slug}`)
  }
  return db().transaction(() => {
    const existing = getDoc(scope, subject, slug)
    const at = nowIso()
    let doc: Doc
    if (existing) {
      db().query('UPDATE doc SET title=?, body=?, updated_at=? WHERE id=?')
        .run(revision.title, revision.body, at, existing.id)
      doc = getDoc(scope, subject, slug)!
    } else {
      db().query(
        `INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(scope, subject, slug, revision.title, revision.body, at, at)
      doc = getDoc(scope, subject, slug)!
    }
    insertRevision(doc, 'restore', context, at)
    return doc
  })()
}

export function diffDocRevisions(a: number, b: number): string {
  const left = getDocRevision(a)
  const right = getDocRevision(b)
  if (!left) throw new Error(`no doc revision ${a}`)
  if (!right) throw new Error(`no doc revision ${b}`)
  const x = left.body.split('\n')
  const y = right.body.split('\n')
  const lengths = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
    lengths[i]![j] = x[i] === y[j] ? lengths[i + 1]![j + 1]! + 1
      : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
  }
  const lines = [`--- revision-${a}`, `+++ revision-${b}`]
  let i = 0; let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { lines.push(` ${x[i]}`); i++; j++ }
    else if (j < y.length && (i === x.length || lengths[i]![j + 1]! > lengths[i + 1]![j]!)) {
      lines.push(`+${y[j++]}`)
    } else lines.push(`-${x[i++]}`)
  }
  return `${lines.join('\n')}\n`
}
