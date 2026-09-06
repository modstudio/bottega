import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isCliCommand } from './args.ts'
import { db, nowIso } from './db.ts'
import { type Doc, docsForRun, docsMarkdown, listDocs } from './docs.ts'
import { DEFAULT_PACK_BYTES, JOBS, job as getJob } from './jobs.ts'
import { projectAt, projectByName } from './projects.ts'

export const BRIEF_BYTES = 64 * 1024
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PREFIXES = ['orchestrator/', 'ops/', 'hub/', 'local-stack/', 'shared/', 'scripts/', '.githooks/']
const BUILT = /(^|\/)(?:dist|build)(?:\/|$)/
const trackedCache = new Map<string, Set<string>>()
const scriptsCache = new Map<string, Set<string>>()

export type PackDoc = {
  revisionId: number
  scope: string
  subject: string | null
  slug: string
  title: string
  bytes: number
}

export type Pack = {
  job: string
  project: string | null
  docs: PackDoc[]
  markdown: string
  bytes: number
  budgetBytes: number
  sha256: string
}

export type Finding = {
  kind: 'path' | 'orch-command' | 'job' | 'bun-script' | 'unchecked'
  token: string
  line: number
  message: string
}

export class CanonBudgetError extends Error {
  constructor(public pack: Pack) {
    const rows = [...pack.docs].sort((a, b) => b.bytes - a.bytes)
      .map((doc) => `  ${doc.bytes}  ${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`)
    super([
      `canon pack is ${pack.bytes} bytes; budget is ${pack.budgetBytes} bytes`,
      ...rows,
      'remedies: mark a document demand, or raise packBytes for this job',
    ].join('\n'))
    this.name = 'CanonBudgetError'
  }
}

function buildPack(job: string, cwd: string, budgetBytes: number, brief = false): Pack {
  const project = projectAt(cwd)
  const selected = brief
    ? [
        ...listDocs({ scope: 'global', subject: null }),
        ...(project ? listDocs({ scope: 'project', subject: project.name }) : []),
      ].filter((doc) => doc.delivery === 'inject')
    : docsForRun({ job, cwd })
  const latest = db().query('SELECT MAX(id) AS id FROM doc_revision WHERE doc_id=?')
  const withRevisions = selected.map((doc: Doc & { revision_id?: number }) => {
    const revisionId = doc.revision_id ?? (latest.get(doc.id) as { id: number | null }).id
    if (revisionId == null) throw new Error(`doc ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} has no revision; refusing canon`)
    return { doc, revisionId }
  })
  const markdown = docsMarkdown(withRevisions.map(({ doc }) => doc))
  const docs = withRevisions.map(({ doc, revisionId }) => ({
    revisionId, scope: doc.scope, subject: doc.subject, slug: doc.slug, title: doc.title,
    bytes: Buffer.byteLength(`## ${doc.title}\n\n${doc.body}`),
  }))
  const bytes = Buffer.byteLength(markdown)
  const pack: Pack = {
    job, project: project?.name ?? null, docs, markdown, bytes, budgetBytes,
    sha256: createHash('sha256').update(markdown).digest('hex'),
  }
  if (bytes > budgetBytes) throw new CanonBudgetError(pack)
  return pack
}

export function compilePack(input: { job: string; cwd: string }): Pack {
  const selected = getJob(input.job)
  return buildPack(input.job, input.cwd, selected.packBytes ?? DEFAULT_PACK_BYTES)
}

export function compileBrief(cwd: string): Pack {
  return buildPack('session', cwd, BRIEF_BYTES, true)
}

function tracked(root: string): Set<string> | null {
  if (!existsSync(root)) return null
  const cached = trackedCache.get(root)
  if (cached) return cached
  const p = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) return null
  const result = new Set(p.stdout.toString().split('\0').filter(Boolean))
  trackedCache.set(root, result)
  return result
}

function scripts(root: string): Set<string> {
  const cached = scriptsCache.get(root)
  if (cached) return cached
  const result = new Set<string>()
  for (const rel of ['package.json', 'orchestrator/package.json', 'hub/package.json', 'hub/web/package.json']) {
    const path = join(root, rel)
    if (!existsSync(path)) continue
    try {
      const json = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> }
      Object.keys(json.scripts ?? {}).forEach((name) => result.add(name))
    } catch { /* A warning pass must never turn a document write into a refusal. */ }
  }
  scriptsCache.set(root, result)
  return result
}

function trackedPath(files: Set<string>, path: string): boolean {
  if (files.has(path)) return true
  const prefix = `${path.replace(/\/$/, '')}/`
  for (const file of files) if (file.startsWith(prefix)) return true
  return false
}

export function checkDoc(body: string, options: { repoRoot: string }): Finding[] {
  const files = tracked(options.repoRoot)
  if (!files) return [{ kind: 'unchecked', token: options.repoRoot, line: 0,
    message: `unchecked: project path is unavailable or not a git checkout: ${options.repoRoot}` }]
  const packageScripts = scripts(options.repoRoot)
  const findings: Finding[] = []
  body.split('\n').forEach((raw, index) => {
    const line = index + 1
    for (const match of raw.matchAll(/`([^`]+)`/g)) {
      const token = match[1]!
      for (const piece of token.split(/\s+/)) {
        if (!PREFIXES.some((prefix) => piece.startsWith(prefix)) || /[<>]/.test(piece) || BUILT.test(piece)) continue
        const path = (piece.split('*')[0] ?? piece).replace(/\/$/, '')
        if (!path || trackedPath(files, path)) continue
        findings.push({ kind: 'path', token: piece, line,
          message: `line ${line}: \`${piece}\` is not tracked in ${options.repoRoot}` })
      }
      const command = token.match(/^orch\s+([a-z][\w-]*)$/)
      if (command && !isCliCommand(command[1]!)) findings.push({ kind: 'orch-command', token, line,
        message: `line ${line}: \`${token}\` names no orch subcommand` })
      const doJob = token.match(/^orch do\s+([a-z][\w-]*)$/)
      if (doJob && !JOBS[doJob[1]!]) findings.push({ kind: 'job', token, line,
        message: `line ${line}: \`${token}\` names no orch job` })
      if (JOBS[token]) { /* Exact job-name tokens are valid by definition. */ }
      const bun = token.match(/^bun run (?:--cwd \S+ )?([a-z][\w:.-]*)(?![\w:.$/-])$/)
      if (bun && !packageScripts.has(bun[1]!)) findings.push({ kind: 'bun-script', token, line,
        message: `line ${line}: \`${token}\` is not defined by a package.json` })
    }
  })
  return findings
}

export function repoRootForDoc(doc: Pick<Doc, 'scope' | 'subject'>): string | null {
  if (doc.scope === 'project') return doc.subject ? projectByName(doc.subject)?.path ?? null : null
  return ROOT
}

export function findingsForPack(pack: Pack): { doc: PackDoc; findings: Finding[] }[] {
  return pack.docs.map((packed) => {
    const doc = getDocForPack(packed)
    const root = repoRootForDoc(doc)
    const findings = root ? checkDoc(doc.body, { repoRoot: root }) : [{
      kind: 'unchecked' as const, token: doc.subject ?? '', line: 0,
      message: `unchecked: project ${doc.subject ?? '(unknown)'} is not registered on this machine`,
    }]
    return { doc: packed, findings }
  })
}

function getDocForPack(packed: PackDoc): Doc {
  return db().query('SELECT * FROM doc WHERE scope=? AND subject IS ? AND slug=?')
    .get(packed.scope, packed.subject, packed.slug) as Doc
}

export function recordPack(pack: Pack): void {
  const findings = findingsForPack(pack).reduce((sum, row) => sum + row.findings.length, 0)
  db().transaction(() => {
    db().query('DELETE FROM canon_pack WHERE job=? AND project IS ?').run(pack.job, pack.project)
    db().query(`INSERT INTO canon_pack
      (job,project,sha256,bytes,doc_count,doc_revisions,compiled_at,findings)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      pack.job, pack.project, pack.sha256, pack.bytes, pack.docs.length,
      JSON.stringify(pack.docs), nowIso(), findings,
    )
  })()
}

export type PackDiff = {
  job: string; project: string | null; current: Pack
  stored: null | { sha256: string; bytes: number; docs: PackDoc[] }
  added: PackDoc[]; removed: PackDoc[]
  changed: { slug: string; fromRevision: number; toRevision: number }[]
  bytesDelta: number
}

export function diffPack(input: { job: string; cwd: string }): PackDiff {
  const current = compilePack(input)
  const row = db().query('SELECT * FROM canon_pack WHERE job=? AND project IS ?')
    .get(current.job, current.project) as { sha256: string; bytes: number; doc_revisions: string } | null
  const storedDocs = row ? JSON.parse(row.doc_revisions) as PackDoc[] : []
  const address = (doc: PackDoc) => `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`
  const before = new Map(storedDocs.map((doc) => [address(doc), doc]))
  const after = new Map(current.docs.map((doc) => [address(doc), doc]))
  return {
    job: current.job, project: current.project, current,
    stored: row ? { sha256: row.sha256, bytes: row.bytes, docs: storedDocs } : null,
    added: current.docs.filter((doc) => !before.has(address(doc))),
    removed: storedDocs.filter((doc) => !after.has(address(doc))),
    changed: current.docs.flatMap((doc) => {
      const old = before.get(address(doc))
      return old && old.revisionId !== doc.revisionId
        ? [{ slug: address(doc), fromRevision: old.revisionId, toRevision: doc.revisionId }] : []
    }),
    bytesDelta: current.bytes - (row?.bytes ?? 0),
  }
}

export function allInjectChecks(): { doc: PackDoc; findings: Finding[] }[] {
  const latest = db().query('SELECT MAX(id) AS id FROM doc_revision WHERE doc_id=?')
  return listDocs().filter((doc) => doc.delivery === 'inject').map((doc) => {
    const revisionId = (latest.get(doc.id) as { id: number | null }).id ?? 0
    const packed = { revisionId, scope: doc.scope, subject: doc.subject, slug: doc.slug,
      title: doc.title, bytes: Buffer.byteLength(`## ${doc.title}\n\n${doc.body}`) }
    const root = repoRootForDoc(doc)
    return { doc: packed, findings: root ? checkDoc(doc.body, { repoRoot: root }) : [{
      kind: 'unchecked', token: doc.subject ?? '', line: 0,
      message: `unchecked: project ${doc.subject ?? '(unknown)'} is not registered on this machine`,
    }] }
  })
}

export function storedPackDrift(): PackDiff[] {
  const rows = db().query('SELECT job, project FROM canon_pack').all() as { job: string; project: string | null }[]
  return rows.flatMap((row) => {
    if (!JOBS[row.job]) return []
    const cwd = row.project ? projectByName(row.project)?.path : ROOT
    if (!cwd) return []
    try {
      const diff = diffPack({ job: row.job, cwd })
      return diff.removed.length || (diff.stored && diff.bytesDelta < -(diff.stored.bytes * .25)) ? [diff] : []
    } catch { return [] }
  })
}
