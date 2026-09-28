// concern: doc-commands
/**
 * Knows document-store command semantics and their presentation. Must not know
 * database writes beyond docs, runs, routing, transports, or the CLI.
 */
import { readFileSync } from 'node:fs'
import { checkDoc, repoRootForDoc } from '../canon/canon.ts'
import { selectCanonWriteTree } from './doc-canon-tree.ts'
import { searchDocs } from './doc-search.ts'
import {
  collectDocReferenceProjects,
  consumeDoc,
  diffDocRevisions,
  docSubjects,
  exportDocs,
  getDoc,
  importDocs,
  lintStoredDoc,
  listDocRevisions,
  listDocs,
  listOpenResumes,
  removeDoc,
  restoreDoc,
  setDoc,
  signedInDocOwner,
  storedDocsHaveRepositoryReferences,
} from './docs.ts'

type DocFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type DocPresentation = {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
  write(value: string): void
  stdinText(): Promise<string>
  stdinIsTTY: boolean
  cwd(): string
  exitCode?(code: number): void
}

export function validateUserAddress(user: boolean, hasSubject: boolean): void {
  if (user && hasSubject) throw new Error('--user cannot be used with --subject')
}

export function userAddressScope(user: boolean, explicitScope: string | undefined) {
  return user ? (explicitScope ?? 'canon') : explicitScope
}

function lintDocs(flags: DocFlags, presentation: DocPresentation): void {
  const scope = flags.flag('scope')
  const subject = flags.flag('subject') ?? null
  const rows = listDocs({ scope, ...(flags.has('subject') ? { subject } : {}) })
  const findings = rows.flatMap((doc) =>
    lintStoredDoc(
      doc,
      storedDocsHaveRepositoryReferences([doc]) ? collectDocReferenceProjects(doc) : undefined,
    ).map((finding) => ({
      scope: doc.scope,
      subject: doc.subject,
      slug: doc.slug,
      ...finding,
    })),
  )
  if (flags.has('json')) presentation.log(JSON.stringify(findings))
  else {
    for (const finding of findings) {
      presentation.log(
        `${finding.scope}/${finding.subject ?? '_'}/${finding.slug}:${finding.line} ${finding.rule} ${finding.message}`,
      )
      presentation.log(`  remedy: ${finding.remedy}`)
    }
  }
  if (findings.length) presentation.exitCode?.(1)
}

function docDelivery(value: string | undefined): 'inject' | 'demand' | undefined {
  if (value === undefined || value === 'inject' || value === 'demand') return value
  throw new Error('--delivery must be inject or demand')
}

function commandCanonTree(
  scope: string,
  subject: string | null,
  flags: DocFlags,
  presentation: DocPresentation,
): ReturnType<typeof selectCanonWriteTree> {
  const tree = selectCanonWriteTree({ scope, subject, cwd: flags.flag('cwd') })
  if (tree && !flags.has('json')) presentation.log(`tree: ${tree.root}`)
  return tree
}

export function formatDocSearchRefresh(refresh: {
  embedded: number
  deleted: number
  unchanged: number
  stale: number
}): string {
  return `refresh: ${refresh.embedded} embedded, ${refresh.deleted} deleted, ${refresh.unchanged} unchanged, ${refresh.stale} stale`
}

async function semanticSearch(
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
): Promise<void> {
  const query = argv[2]
  if (!query) throw new Error('orch doc search "<query>" [--k N] [--json]')
  const rawK = flags.flag('k') ?? '5'
  if (!/^\d+$/.test(rawK) || Number(rawK) < 1) throw new Error('--k must be a positive integer')
  const output = await searchDocs(query, Number(rawK))
  if (flags.has('json')) {
    presentation.log(JSON.stringify(output))
    return
  }
  presentation.log(formatDocSearchRefresh(output.refresh))
  for (const result of output.results) {
    presentation.log(
      `${result.scope}/${result.subject ?? '_'}/${result.slug} · ${result.headingPath.join(' > ') || result.title}`,
    )
    presentation.log(`  ${result.snippet}${result.truncated ? '…' : ''}`)
  }
}

async function handledEarlyDocCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
): Promise<boolean> {
  if (sub === 'lint') lintDocs(flags, presentation)
  else if (sub === 'search') await semanticSearch(argv, flags, presentation)
  else return false
  return true
}

function handledReadDocCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
  address: { scope: string | undefined; subject: string | null; owner: string | null },
): boolean {
  const { has } = flags
  if (sub === 'list') {
    const rows = listDocs({
      scope: address.scope,
      ...(has('subject') || has('user') ? { subject: address.subject } : {}),
      owner: address.owner,
    })
    if (has('json')) presentation.log(JSON.stringify(rows))
    else if (rows.length) {
      presentation.log(
        'scope    subject          slug                     title                    delivery  bytes  updated',
      )
      for (const d of rows) {
        presentation.log(
          `${d.scope.padEnd(8)} ${(d.subject ?? '-').padEnd(16)} ${d.slug.padEnd(24)} ` +
            `${d.title.padEnd(24)} ${d.delivery.padEnd(8)} ${String(Buffer.byteLength(d.body)).padStart(6)}  ${d.updated_at}`,
        )
      }
    }
    return true
  }
  if (sub !== 'show' && sub !== 'get') return false
  const slug = argv[2]
  if (!slug || !address.scope) throw new Error(`orch doc ${sub} <slug> --scope S [--subject X]`)
  const doc = getDoc(address.scope, address.subject, slug, address.owner)
  if (!doc)
    throw new Error(`no ${address.scope} doc "${slug}"; use orch doc list --scope ${address.scope}`)
  if (has('json')) presentation.log(JSON.stringify(doc))
  else presentation.write(doc.body)
  return true
}

export async function docCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
): Promise<void> {
  const { has, flag } = flags
  validateUserAddress(has('user'), has('subject'))
  const scope = userAddressScope(has('user'), flag('scope'))
  const subject = has('user') ? null : (flag('subject') ?? null)
  const owner = has('user') ? await signedInDocOwner() : null
  if (await handledEarlyDocCommand(sub, argv, flags, presentation)) return
  if (handledReadDocCommand(sub, argv, flags, presentation, { scope, subject, owner })) return
  if (sub === 'set') {
    const slug = argv[2]
    const title = flag('title')
    const reason = flag('reason')
    if (!slug || !scope || title === undefined || !reason?.trim()) {
      throw new Error(
        'orch doc set <slug> --scope S [--subject X] [--cwd PATH] --title T --reason TEXT [--expect REVISION] (--file F | body on stdin)',
      )
    }
    const canonTree = commandCanonTree(scope, subject, flags, presentation)
    const body = flag('file')
      ? readFileSync(flag('file')!, 'utf8')
      : !presentation.stdinIsTTY
        ? await presentation.stdinText()
        : (() => {
            throw new Error('no body: pass --file F or pipe markdown on stdin')
          })()
    const delivery = docDelivery(flag('delivery'))
    const forceInject = flag('force-inject')
    if (has('force-inject') && !forceInject?.trim())
      throw new Error('--force-inject requires a non-empty reason')
    const doc = await setDoc({
      scope,
      subject,
      owner,
      slug,
      title,
      body,
      reason,
      author: flag('author'),
      forceInject,
      delivery,
      expectedRevision: flag('expect'),
      canonTree,
    })
    const root = repoRootForDoc(doc, canonTree?.root)
    const warnings = root ? checkDoc(body, { repoRoot: root }) : []
    if (has('json')) presentation.log(JSON.stringify({ ...doc, warnings, tree: canonTree?.root }))
    else {
      presentation.log(`set ${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`)
      for (const warning of warnings) presentation.error(`warning: ${warning.message}`)
    }
    return
  }
  if (sub === 'consume') {
    const slug = argv[2]
    if (!slug || !scope)
      throw new Error('orch doc consume <slug> --scope S [--subject X] [--expect REVISION]')
    const result = await consumeDoc(scope, subject, slug, {
      reason: flag('reason') ?? 'consumed by session',
      author: flag('author'),
      expectedRevision: flag('expect'),
    })
    if (has('json')) {
      presentation.log(JSON.stringify(result))
      return
    }
    presentation.log(
      result.already_consumed
        ? `already consumed ${result.scope}/${result.subject ?? '_'}/${result.slug}`
        : `consumed ${result.scope}/${result.subject ?? '_'}/${result.slug}`,
    )
    return
  }
  if (sub === 'rm') {
    const slug = argv[2]
    const reason = flag('reason')
    if (!slug || !scope || !reason?.trim())
      throw new Error(
        'orch doc rm <slug> --scope S [--subject X] [--cwd PATH] --reason TEXT [--expect REVISION]',
      )
    const canonTree = commandCanonTree(scope, subject, flags, presentation)
    const removed = await removeDoc(
      scope,
      subject,
      slug,
      {
        reason,
        author: flag('author'),
        expectedRevision: flag('expect'),
        canonTree,
      },
      owner,
    )
    if (has('json')) {
      presentation.log(JSON.stringify({ removed, tree: canonTree?.root }))
      return
    }
    presentation.log(
      removed ? `removed ${scope}/${subject ?? '_'}/${slug}` : `no ${scope} doc "${slug}"`,
    )
    return
  }
  if (sub === 'subjects') {
    const subjects = docSubjects()
    if (has('json')) {
      presentation.log(JSON.stringify(subjects))
      return
    }
    for (const [name, names] of Object.entries(subjects)) {
      presentation.log(`${name.padEnd(8)} ${names.join(', ') || '(none)'}`)
    }
    return
  }
  if (sub === 'export' || sub === 'import') {
    const dir = argv[2]
    if (!dir) throw new Error(`orch doc ${sub} <dir>`)
    const reason = flag('reason')
    if (sub === 'import' && !reason?.trim())
      throw new Error('orch doc import <dir> --reason TEXT [--author NAME]')
    const count =
      sub === 'export'
        ? exportDocs(dir)
        : await importDocs(dir, { reason: reason!, author: flag('author') })
    presentation.log(`${sub === 'export' ? 'exported' : 'imported'} ${count} docs`)
    return
  }
  if (sub === 'history' || sub === 'diff' || sub === 'restore') {
    const addressScope = argv[2]
    const rawAddressSubject = argv[3]
    const slug = argv[4]
    if (!addressScope || rawAddressSubject === undefined || !slug) {
      throw new Error(
        `orch doc ${sub} <scope> <subject|-> <slug>${sub === 'restore' ? ' <rev> --reason TEXT' : ''}`,
      )
    }
    const addressSubject = rawAddressSubject === '-' ? null : rawAddressSubject
    if (has('user') && (addressScope !== 'canon' || addressSubject !== null)) {
      throw new Error('--user history address must be canon -')
    }
    const revisions = listDocRevisions(addressScope, addressSubject, slug, owner)
    if (sub === 'history') {
      if (has('json')) presentation.log(JSON.stringify(revisions))
      else
        for (const revision of revisions) {
          presentation.log(
            `${revision.id}  ${revision.op.padEnd(8)} ${revision.author}  ${revision.at}  ${revision.bytes} bytes  ${revision.reason}`,
          )
        }
      return
    }
    if (sub === 'diff') {
      const a = argv[5] ? Number(argv[5]) : revisions[1]?.id
      const b = argv[6] ? Number(argv[6]) : revisions[0]?.id
      if (!a || !b) throw new Error('doc diff needs two revisions; this address has fewer than two')
      const addressIds = new Set(revisions.map((revision) => revision.id))
      if (!addressIds.has(a) || !addressIds.has(b)) {
        throw new Error(
          `doc diff revisions must belong to ${addressScope}/${addressSubject ?? '_'}/${slug}`,
        )
      }
      presentation.write(diffDocRevisions(a, b, owner))
      return
    }
    const revisionId = Number(argv[5])
    const reason = flag('reason')
    if (!revisionId || !reason?.trim()) {
      throw new Error(
        'orch doc restore <scope> <subject|-> <slug> <rev> --reason TEXT [--expect REVISION]',
      )
    }
    const restored = await restoreDoc(
      addressScope,
      addressSubject,
      slug,
      revisionId,
      {
        reason,
        author: flag('author'),
        expectedRevision: flag('expect'),
      },
      owner,
    )
    presentation.log(
      has('json')
        ? JSON.stringify(restored)
        : `restored ${addressScope}/${addressSubject ?? '_'}/${slug}`,
    )
    return
  }
  if (sub === 'resumes') {
    const result = listOpenResumes(flag('cwd') ?? presentation.cwd())
    if (has('json')) {
      presentation.log(JSON.stringify(result))
      return
    }
    for (const r of result.open) {
      presentation.log(`${r.slug.padEnd(24)} ${r.title.padEnd(24)} ${r.age}`)
    }
    for (const r of result.unreadable) {
      presentation.error(`unreadable resume brief ${r.slug}: ${r.reason}`)
    }
    return
  }
  throw new Error(
    `unknown: orch doc ${sub}. Try list | get | show | search | set | lint | consume | rm | history | diff | restore | subjects | export | import | resumes`,
  )
}
