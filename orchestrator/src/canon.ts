import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONCERNS } from '../../shared/brand.ts'
import {
  CANON_REFERENCE_EXEMPTIONS,
  canonReferencePath,
} from '../../shared/canon-references.ts'
import { isCliCommand } from './args.ts'
import { db, linkedWorktreeReadOnly, nowIso, writeTransaction } from './db.ts'
import { type Doc, docsForRun, docsMarkdown, listDocs } from './docs.ts'
import { DEFAULT_PACK_BYTES, JOBS, job as getJob } from './jobs.ts'
import { projectAt, projectByName, projects } from './projects.ts'
import { targetGitEnvironment } from './worktree.ts'

export const BRIEF_BYTES = 64 * 1024
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PREFIXES = ['orchestrator/', 'ops/', 'hub/', 'local-stack/', 'shared/', 'scripts/', '.githooks/']
const BUILT = /(^|\/)(?:dist|build)(?:\/|$)/
const EXEMPT_PATHS = new Set(CANON_REFERENCE_EXEMPTIONS.map((exemption) => exemption.path))
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

export type NumericLiteralClass = 'RESTATED' | 'OWNED' | 'CHECKED' | 'EVIDENCE' | 'UNCLASSIFIED'

export type NumericLiteral = {
  source: string
  line: number
  sentence: string
  numeral: string
  classification: NumericLiteralClass
}

// Spelled-out numbers stay out of scope: this report finds numeric literals only.
const NUMERAL = /\b[A-Za-z]+\d+(?:\.\d+)+\b|(?<![\w])~?[+-]?\d[\d,]*(?:\.\d+)*(?:%|\+)?/g
const MASKED_PROSE_SPANS = [
  /^(?:\s*[-*+]\s+)?\d+[.)]\s/gm,
  /\b(?:https?|file):\/\/\S+/gi,
  /(?:^|[\s(])(?:\.{0,2}\/|\/)[^\s)]+/g,
  /\b[\w.-]+(?:\/[\w.-]+)+(?::\d+(?::\d+)?)?\b/g,
  /\b[\w-]*\d[\w.-]*\.[A-Za-z][\w.-]*\b/g,
]
const EXCLUDED_NUMERIC_FORMS = [
  /\b[A-Z][A-Z0-9]+-\d+\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/gi,
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  /(?:^|[^\w./-])(?:[\w.-]+\/)+[\w.-]+:\d+(?::\d+)?(?:-\d+)?\b|(?:^|[^\w./-])[\w-]+\.[A-Za-z][\w.-]*:\d+(?::\d+)?(?:-\d+)?\b/g,
  /\blines?\s+\d+(?:-\d+)?\b/gi,
  /\b\d+(?:st|nd|rd|th)\b/gi,
  ...MASKED_PROSE_SPANS,
]

function overlaps(start: number, end: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start)
}

function localClause(text: string, start: number, end: number): string {
  const delimiters = [...text.matchAll(/;|[—–]|\s-\s|,(?=\s)|\b(?:and|but|so)\b/gi)]
  const before = delimiters.filter((delimiter) => delimiter.index < start).at(-1)
  const after = delimiters.find((delimiter) => delimiter.index >= end)
  return text.slice(before ? before.index + before[0].length : 0, after?.index ?? text.length).trim()
}

function numericClass(clause: string, sentence: string, numeral: string): NumericLiteralClass {
  const date = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}/i
  if (/\bmeasur(?:e[ds]?|ing)\b|\bobserved\b|\bruns?\s+(?:id\s*:?\s*)?#?\d/i.test(clause) ||
      (/\brecorded\s+on\b/i.test(clause) && date.test(clause)) || date.test(clause)) {
    return 'EVIDENCE'
  }
  if (/\basserts?\b|\brefuses?\b|\bcheck(?:s|ed|ing)?\b/i.test(clause)) return 'CHECKED'
  const escaped = numeral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (
    /\bdefaults?\b|\btier\s+\d/i.test(clause) ||
    /^\s*\|.*\|\s*$/.test(clause) ||
    /\b(?:defines?|owns?|enforces?|requires?|sets?)\b[^.!?]{0,80}\bthreshold\b|\bthreshold\b[^.!?]{0,80}\b(?:enforces?|required|must)\b/i.test(clause) ||
    /\bonly\s+(?:once|after|when)\b|\bmost recent\s+\d/i.test(clause) ||
    new RegExp(`\\b(?:first|last|under|over)\\s+${escaped}(?![\\d.])`, 'i').test(clause) ||
    new RegExp(`--[\\w-]+=${escaped}(?![\\d.])`, 'i').test(clause) ||
    new RegExp(`\\bexit(?:s|ed)?(?:\\s+(?:status|code))?\\s+${escaped}\\b`, 'i').test(clause) ||
    new RegExp(`(?:at (?:most|least)|no (?:more|fewer) than|exactly|maximum|min(?:imum)?|limit(?:ed)? to)\\s+${escaped}`, 'i').test(clause)
  ) return 'OWNED'
  const mutableNoun = /\b(?:tests?|rows?|ports?|versions?|bytes?|files?|lines?|characters?|records?|items?|entries?|requests?|tokens?|seconds?|minutes?|hours?|percent(?:age)?|rates?|sizes?|totals?|counts?)\b|%/i
  const current = /\b(?:currently|today|now|has|have|is|are|runs?\s+at|serves?\s+at|listens?\s+on|ships?|contains?)\b/i
  const historicalOrQuoted = /\b(?:had|was|were|did|used|cost|filed|printed|reported|recorded|exited|reconstructed|made|recoverable|history|runs?\s+\d+|previous(?:ly)?|historical|incident|before|after|ago|do not trust|don't trust|example|claim(?:ed|s)?|reading it as|a day)\b/i
  const toolVersion = /^[A-Za-z]+\d+(?:\.\d+)+$/.test(numeral) ||
    ((numeral.match(/\./g)?.length ?? 0) >= 2 &&
      new RegExp(`\\b[A-Za-z][\\w-]*\\s+${escaped}`).test(clause))
  const bareMutable = new RegExp(`${escaped}\\s+[^.!?]*(?:${mutableNoun.source})`, 'i').test(clause)
  if (toolVersion || (mutableNoun.test(clause) && !historicalOrQuoted.test(clause) &&
      (current.test(clause) || (bareMutable && !historicalOrQuoted.test(sentence))))) {
    return 'RESTATED'
  }
  return 'UNCLASSIFIED'
}

/** Classify prose numerals without consulting the filesystem or database. */
export function numericLiteralReport(text: string, source: string): NumericLiteral[] {
  const hits: NumericLiteral[] = []
  let fenced = false
  let masked = text.split('\n').map((raw) => {
    const line = raw.replace(/\r$/, '')
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced
      return ' '.repeat(raw.length)
    }
    return fenced ? ' '.repeat(raw.length) : line.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length))
  }).join('\n')
  for (const pattern of MASKED_PROSE_SPANS) {
    masked = masked.replace(pattern, (span) => ' '.repeat(span.length))
  }
  const sentenceStarts = [0]
  for (let index = 0; index < masked.length; index++) {
    const paragraphEnd = masked[index] === '\n' && masked[index + 1] === '\n'
    const punctuationEnd = /[.!?]/.test(masked[index]!) &&
      (index === masked.length - 1 || /\s/.test(masked[index + 1]!))
    if (paragraphEnd || punctuationEnd) sentenceStarts.push(index + 1)
  }
  for (let part = 0; part < sentenceStarts.length; part++) {
    const sentenceStart = sentenceStarts[part]!
    const sentenceEnd = sentenceStarts[part + 1] ?? masked.length
    const sentenceVisible = masked.slice(sentenceStart, sentenceEnd)
    const ranges = EXCLUDED_NUMERIC_FORMS.flatMap((pattern) =>
      [...sentenceVisible.matchAll(pattern)].map((match) => ({
        start: match.index,
        end: match.index + match[0].length,
      })),
    )
    for (const match of sentenceVisible.matchAll(NUMERAL)) {
      if (overlaps(match.index, match.index + match[0].length, ranges)) continue
      const absolute = sentenceStart + match.index
      const sentence = text.slice(sentenceStart, sentenceEnd).replace(/\s+/g, ' ').trim()
      const clause = localClause(sentenceVisible, match.index, match.index + match[0].length)
      hits.push({
        source,
        line: text.slice(0, absolute).split('\n').length,
        sentence,
        numeral: match[0],
        classification: numericClass(clause, sentence, match[0]),
      })
    }
  }
  return hits
}

function checkoutRoot(cwd: string): string | null {
  if (!existsSync(cwd)) return null
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
    })
    return result.exitCode === 0 ? result.stdout.toString().trim() : null
  } catch { return null }
}

/** The report is deliberately broader than the pack and deliberately never refuses. */
export function allNumericLiterals(cwd: string): {
  numericLiterals: NumericLiteral[]
  canonFiles: { read: string[]; missing: string[] }
} {
  const report = projects().flatMap((project) => {
    const settings = project.settings && typeof project.settings === 'object' ? project.settings : null
    const candidate = settings?.worktree
    const worktree = candidate && typeof candidate === 'object' ? candidate : null
    return [
      ...(typeof worktree?.notes === 'string'
        ? numericLiteralReport(worktree.notes, `register:${project.name} notes`) : []),
      ...(typeof worktree?.readonly_notes === 'string'
        ? numericLiteralReport(worktree.readonly_notes, `register:${project.name} readonly_notes`) : []),
    ]
  })
  const canonFiles = { read: [] as string[], missing: [] as string[] }
  const root = checkoutRoot(cwd)
  if (!root) return { numericLiterals: report, canonFiles }
  const files = ['AGENTS.md', ...CONCERNS.map((concern) => `${concern}/AGENTS.md`)]
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) {
      canonFiles.missing.push(file)
      continue
    }
    canonFiles.read.push(file)
    report.push(...numericLiteralReport(readFileSync(path, 'utf8'), file).map((hit) => ({
      ...hit, source: `${file}:${hit.line}`,
    })))
  }
  return { numericLiterals: report, canonFiles }
}

export class CanonBudgetError extends Error {
  constructor(public pack: Pack) {
    const rows = [...pack.docs].sort((a, b) => b.bytes - a.bytes)
      .map((doc) => `  ${doc.bytes}  ${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`)
    super([
      `canon pack is ${pack.bytes} bytes; budget is ${pack.budgetBytes} bytes`,
      ...rows,
      'remedy: demote the named largest inject sections to demand documents',
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
  const p = Bun.spawnSync(['git', 'ls-files', '-z'], {
    cwd: root, env: targetGitEnvironment(root), stdout: 'pipe', stderr: 'pipe',
  })
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
        if (!PREFIXES.some((prefix) => piece.startsWith(prefix)) || /[<>]/.test(piece)) continue
        const referencePath = canonReferencePath(piece)
        if (BUILT.test(referencePath) || EXEMPT_PATHS.has(referencePath)) continue
        const path = (referencePath.split('*')[0] ?? referencePath).replace(/\/$/, '')
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
  if (linkedWorktreeReadOnly) return
  const findings = findingsForPack(pack).reduce((sum, row) => sum + row.findings.length, 0)
  writeTransaction(() => {
    db().query('DELETE FROM canon_pack WHERE job=? AND project IS ?').run(pack.job, pack.project)
    const projectId = pack.project ? projectByName(pack.project)?.id ?? null : null
    db().query(`INSERT INTO canon_pack
      (job,project,project_id,sha256,bytes,doc_count,doc_revisions,compiled_at,findings)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      pack.job, pack.project, projectId, pack.sha256, pack.bytes, pack.docs.length,
      JSON.stringify(pack.docs), nowIso(), findings,
    )
  })
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
