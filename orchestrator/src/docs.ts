/**
 * Operator documents are scoped facts about the installation around this router.
 * Global facts apply everywhere; project, agent, and job facts attach to one named
 * subject, while machine facts describe the host itself. Worker prompts receive
 * only global, job, and current-project documents; agent and machine notes serve
 * routing and architectural judgement instead. If an adopter needs text unchanged,
 * it is canon in the repository; if it describes this estate, it belongs here.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENTS } from './agents.ts'
import { db, nowIso } from './db.ts'
import { JOBS } from './jobs.ts'
import { projectAt, projectByName } from './projects.ts'

export const DOC_SCOPES = ['project', 'machine', 'agent', 'job', 'global'] as const
export type DocScope = typeof DOC_SCOPES[number]

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

function validScope(scope: string): asserts scope is DocScope {
  if (!DOC_SCOPES.includes(scope as DocScope)) {
    throw new Error(`unknown doc scope "${scope}"; valid scopes: ${DOC_SCOPES.join(', ')}`)
  }
}

function validate(scope: string, subject: string | null, slug: string): asserts scope is DocScope {
  validScope(scope)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length > 64) {
    throw new Error('invalid slug; use 1-64 lowercase letters, digits, or hyphens, starting with a letter or digit')
  }
  if (scope === 'machine' || scope === 'global') {
    if (subject !== null) throw new Error(`${scope} docs take no subject; remove --subject`)
    return
  }
  if (!subject) throw new Error(`${scope} docs require --subject; valid values: ${validSubjects(scope)}`)
  if (scope === 'project' && !projectByName(subject)) {
    throw new Error(`unknown project subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
  if (scope === 'agent' && !AGENTS[subject]) {
    throw new Error(`unknown agent subject "${subject}"; valid values: ${validSubjects(scope)}`)
  }
  if (scope === 'job' && !JOBS[subject]) {
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

function validSubjects(scope: 'project' | 'agent' | 'job'): string {
  const values = scope === 'project'
    ? db().query('SELECT name FROM project ORDER BY name').all().map((r: any) => r.name)
    : Object.keys(scope === 'agent' ? AGENTS : JOBS).sort()
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

export function getDoc(scope: string, subject: string | null, slug: string): Doc | null {
  validScope(scope)
  return db().query(
    'SELECT * FROM doc WHERE scope = ? AND subject IS ? AND slug = ?',
  ).get(scope, subject, slug) as Doc | null
}

export function setDoc(input: {
  scope: string; subject: string | null; slug: string; title: string; body: string
}): Doc {
  validate(input.scope, input.subject, input.slug)
  const existing = getDoc(input.scope, input.subject, input.slug)
  const at = nowIso()
  if (existing) {
    db().query('UPDATE doc SET title=?, body=?, updated_at=? WHERE id=?')
      .run(input.title, input.body, at, existing.id)
    return getDoc(input.scope, input.subject, input.slug)!
  }
  const id = (db().query(
    `INSERT INTO doc (scope, subject, slug, title, body, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
  ).get(input.scope, input.subject, input.slug, input.title, input.body, at, at) as { id: number }).id
  return db().query('SELECT * FROM doc WHERE id=?').get(id) as Doc
}

export function removeDoc(scope: string, subject: string | null, slug: string): boolean {
  validScope(scope)
  return db().query(
    'DELETE FROM doc WHERE scope = ? AND subject IS ? AND slug = ?',
  ).run(scope, subject, slug).changes > 0
}

export function docsForRun(input: { job: string; cwd: string }): Doc[] {
  const project = projectAt(input.cwd)
  return [
    ...listDocs({ scope: 'global', subject: null }),
    ...listDocs({ scope: 'job', subject: input.job }),
    ...(project ? listDocs({ scope: 'project', subject: project.name }) : []),
  ]
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

export function exportDocs(dir: string): number {
  const docs = listDocs()
  for (const doc of docs) {
    const target = join(dir, doc.scope, doc.subject ?? '_')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, `${doc.slug}.md`), `---\ntitle: ${JSON.stringify(doc.title)}\n---\n\n${doc.body}`)
  }
  return docs.length
}

export function importDocs(dir: string): number {
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
        setDoc({ scope, subject, slug: file.name.slice(0, -3), title, body: match[2]! })
        count++
      }
    }
  }
  return count
}
