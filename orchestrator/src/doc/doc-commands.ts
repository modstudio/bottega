// concern: doc-commands
/**
 * Knows document-store command semantics and their presentation. Must not know
 * database writes beyond docs, runs, routing, transports, or the CLI.
 */
import { readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  DOC_AUDIENCES,
  DOC_FORMS,
  DOC_KINDS,
  DOC_STATUSES,
  type DocAudience,
  type DocAudiences,
  type DocForm,
  type DocKind,
  type DocStatus,
  effectiveDocSummary,
  normalizeDocAudiences,
  normalizeDocSummary,
} from '../../../shared/docs.ts'
import { checkDoc, repoRootForDoc } from '../canon/canon.ts'
import type { CanonLintInputCollector } from '../canon/canon-files.ts'
import { db } from '../database/db.ts'
import { cachedSignedInRecordUser } from '../record/record-session.ts'
import { handleDocConsumeCommand } from './doc-consume-command.ts'
import { resolveDocRevisionIdentifier } from './doc-revision-identifier.ts'
import { searchDocs } from './doc-search-service.ts'
import type { SelectedDocWriteTree } from './doc-write-tree.ts'
import {
  diffDocRevisions,
  docSubjects,
  exportDocs,
  getDoc,
  getDocForAudience,
  importDocs,
  lintStoredDoc,
  listDocMetadata,
  listDocRevisions,
  listDocs,
  listOpenResumes,
  readDocRevision,
  removeDoc,
  reorderDocs,
  restoreDoc,
  setDoc,
  setDocStatus,
  signedInDocOwner,
  storedDocWarnings,
  validateDocAddressFilter,
} from './docs.ts'

const DOC_KEYWORD_LIST_LIMIT = 50

const compareStoreText = (left: string, right: string) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right))

type DocFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
  values?(name: string): string[]
}
type DocPresentation = {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
  write(value: string): void
  stdinText(): Promise<string>
  stdinIsTTY: boolean
  cwd(): string
  exitCode?(code: number): void
}
type DocCommandPorts = {
  selectDocWriteTree(input: {
    scope: string
    subject: string | null
    cwd?: string
  }): SelectedDocWriteTree | undefined
  collectCanonLintInput: CanonLintInputCollector
  consumeResumeHandoff?(
    doc: Awaited<ReturnType<typeof import('./docs.ts').consumeDoc>>,
  ): Promise<{
    lines: string[]
    [key: string]: unknown
  }>
}

function revisionAuthorName(author: string, user: ReturnType<typeof cachedSignedInRecordUser>) {
  return author === user?.id ? (user.name ?? user.email) : null
}

export function validateUserAddress(user: boolean, hasSubject: boolean): void {
  if (user && hasSubject) throw new Error('--user cannot be used with --subject')
}

export function userAddressScope(user: boolean, explicitScope: string | undefined) {
  return user ? (explicitScope ?? 'canon') : explicitScope
}

function lintDocs(flags: DocFlags, presentation: DocPresentation): void {
  const findings = listedDocFindings(flags, lintStoredDoc)
  if (flags.has('json')) presentation.log(JSON.stringify(findings))
  else {
    for (const finding of findings) {
      presentation.log(
        `${finding.scope}/${finding.subject ?? '_'}/${finding.slug}:${finding.line} ${finding.rule} ${finding.level} ${finding.message}`,
      )
      presentation.log(`  remedy: ${finding.remedy}`)
    }
  }
  if (findings.some(({ level }) => level === 'error')) presentation.exitCode?.(1)
}

function listedDocFindings(
  flags: DocFlags,
  lint: (doc: ReturnType<typeof listDocs>[number]) => ReturnType<typeof lintStoredDoc>,
) {
  const scope = flags.flag('scope')
  const subject = flags.flag('subject') ?? null
  return listDocs({ scope, ...(flags.has('subject') ? { subject } : {}) }).flatMap((doc) =>
    lint(doc).map((finding) => ({
      scope: doc.scope,
      subject: doc.subject,
      slug: doc.slug,
      ...finding,
    })),
  )
}

function docWarningAddress(doc: { scope: string; subject: string | null; slug: string }) {
  return `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`
}

function listDocWarnings(flags: DocFlags, presentation: DocPresentation): void {
  const scope = flags.flag('scope')
  if (!scope) throw new Error(`${PLATFORM_SLUG} doc warnings --scope S [--subject X] [--json]`)
  const warnings = listedDocFindings(flags, storedDocWarnings).map(
    ({ scope: warningScope, subject, slug, line, message, remedy }) => ({
      address: docWarningAddress({ scope: warningScope, subject, slug }),
      line,
      message,
      remedy,
    }),
  )
  if (flags.has('json')) {
    presentation.log(JSON.stringify(warnings))
    return
  }
  if (!warnings.length) {
    presentation.log('warnings: none')
    return
  }
  for (const warning of warnings)
    presentation.log(`${warning.address}:${warning.line} ${warning.message}; ${warning.remedy}`)
}

function docDelivery(value: string | undefined): 'inject' | 'demand' | undefined {
  if (value === undefined || value === 'inject' || value === 'demand') return value
  throw new Error('--delivery must be inject or demand')
}

function docAudiences(value: string | undefined): DocAudiences | undefined {
  if (value === undefined) return undefined
  try {
    return normalizeDocAudiences(value.split(',').map((audience) => audience.trim()))
  } catch (error) {
    throw new Error(
      `--audience must be a comma-separated set of ${DOC_AUDIENCES.join(' or ')}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function docReadAudience(value: string | undefined): DocAudience | undefined {
  if (value === undefined) return undefined
  if (DOC_AUDIENCES.includes(value as DocAudience)) {
    return value as DocAudience
  }
  throw new Error(`--audience must be one of ${DOC_AUDIENCES.join(', ')}`)
}

function docStatus(value: string | undefined): DocStatus | undefined {
  if (value === undefined) return undefined
  if (DOC_STATUSES.includes(value as DocStatus)) return value as DocStatus
  throw new Error(`--status must be ${DOC_STATUSES.join(' or ')}`)
}

function docKind(value: string | undefined): DocKind | undefined {
  if (value === undefined) return undefined
  if (DOC_KINDS.includes(value as DocKind)) return value as DocKind
  throw new Error(`--kind must be ${DOC_KINDS.join(' or ')}`)
}

function docPosition(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^-?\d+$/.test(value)) throw new Error('--position must be an integer')
  return Number(value)
}

function commandDocWriteTree(
  scope: string,
  subject: string | null,
  flags: DocFlags,
  presentation: DocPresentation,
  ports: DocCommandPorts,
): SelectedDocWriteTree | undefined {
  const tree = ports.selectDocWriteTree({
    scope,
    subject,
    cwd: flags.flag('cwd'),
  })
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
  if (!query)
    throw new Error(
      `${PLATFORM_SLUG} doc search "<query>" [--scope S] [--subject X] [--k N] [--json]`,
    )
  const rawK = flags.flag('k') ?? '5'
  if (!/^\d+$/.test(rawK) || Number(rawK) < 1) throw new Error('--k must be a positive integer')
  const filter = {
    ...(flags.has('scope') ? { scope: flags.flag('scope') } : {}),
    ...(flags.has('subject') ? { subject: flags.flag('subject') } : {}),
    ...(flags.has('include-drafts') ? { includeDrafts: true } : {}),
  }
  validateDocAddressFilter(filter)
  const output = await searchDocs(query, Number(rawK), filter)
  if (flags.has('json')) {
    presentation.log(JSON.stringify(output))
    return
  }
  presentation.log(formatDocSearchRefresh(output.refresh))
  for (const result of output.results) {
    presentation.log(
      `${result.scope}/${result.subject ?? '_'}/${result.slug} [${result.status}] · ${result.headingPath.join(' > ') || result.title}`,
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
  else if (sub === 'warnings') listDocWarnings(flags, presentation)
  else if (sub === 'search') await semanticSearch(argv, flags, presentation)
  else return false
  return true
}

function keywordListDocs(
  filters: NonNullable<Parameters<typeof listDocMetadata>[0]>,
  match: string | undefined,
  bodyMatch: string | undefined,
) {
  const normalizedMatch = match?.toLocaleLowerCase()
  const metadata = [
    ...(match !== undefined
      ? listDocMetadata({ ...filters, match }).filter((doc) =>
          [doc.title, doc.slug].some((value) =>
            value.toLocaleLowerCase().includes(normalizedMatch!),
          ),
        )
      : []),
    ...(bodyMatch !== undefined ? listDocMetadata({ ...filters, bodyMatch }) : []),
  ]
  return [...new Map(metadata.map((doc) => [doc.record_id, doc])).values()]
    .sort(
      (left, right) =>
        compareStoreText(left.scope, right.scope) ||
        compareStoreText(left.subject ?? '', right.subject ?? '') ||
        left.position - right.position ||
        compareStoreText(left.title, right.title),
    )
    .slice(0, DOC_KEYWORD_LIST_LIMIT)
    .map((doc) =>
      filters.audience
        ? getDocForAudience(
            doc.scope,
            doc.subject,
            doc.slug,
            filters.audience as (typeof DOC_AUDIENCES)[number],
            filters.owner ?? null,
          )
        : getDoc(doc.scope, doc.subject, doc.slug, filters.owner ?? null),
    )
    .filter((doc) => doc !== null)
}

function listedDocs(
  filters: NonNullable<Parameters<typeof listDocMetadata>[0]>,
  match: string | undefined,
  bodyMatch: string | undefined,
) {
  if (match === undefined && bodyMatch === undefined) return listDocs(filters)
  return keywordListDocs(filters, match, bodyMatch)
}

function readDoc(
  address: { scope: string; subject: string | null | undefined; owner: string | null },
  slug: string,
  audience: DocAudience | undefined,
) {
  return audience
    ? getDocForAudience(address.scope, address.subject, slug, audience, address.owner)
    : getDoc(address.scope, address.subject, slug, address.owner)
}

function readDocFilters(
  flags: DocFlags,
  address: { scope: string | undefined; subject: string | null; owner: string | null },
) {
  return {
    scope: address.scope,
    ...(flags.has('subject') || flags.has('user') ? { subject: address.subject } : {}),
    owner: address.owner,
    audience: flags.flag('audience'),
    status: flags.flag('status'),
    kind: flags.flag('kind'),
    articleSubject: flags.flag('article-subject'),
  }
}

function readDocSubject(
  flags: DocFlags,
  address: { subject: string | null },
): string | null | undefined {
  if (!flags.has('subject') && !flags.has('user')) return undefined
  return address.subject
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
    const filters = readDocFilters(flags, address)
    const match = flags.flag('match')
    const bodyMatch = flags.flag('body-match')
    const rows = listedDocs(filters, match, bodyMatch)
    if (has('json'))
      presentation.log(
        JSON.stringify(
          rows.map((doc) => ({ ...doc, ...effectiveDocSummary(doc.summary, doc.body) })),
        ),
      )
    else if (rows.length) {
      presentation.log(
        'scope    subject          slug                     title                    kind     form       article-subject  related  sources  status      delivery  bytes  updated',
      )
      for (const d of rows) {
        presentation.log(
          `${d.scope.padEnd(8)} ${(d.subject ?? '-').padEnd(16)} ${d.slug.padEnd(24)} ` +
            `${d.title.padEnd(24)} ${d.kind.padEnd(8)} ${(d.form ?? '-').padEnd(10)} ${(d.articleSubject?.name ?? '-').padEnd(16)} ${String(d.relatedSubjects.length).padStart(7)} ${String(d.sourceFiles.length).padStart(7)} ${d.status.padEnd(11)} ${d.delivery.padEnd(8)} ${String(Buffer.byteLength(d.body)).padStart(6)}  ${d.updated_at}`,
        )
      }
    }
    return true
  }
  if (sub !== 'show' && sub !== 'get') return false
  const slug = argv[2]
  if (!slug || !address.scope)
    throw new Error(`${PLATFORM_SLUG} doc ${sub} <slug> --scope S [--subject X]`)
  const doc = readDoc(
    {
      scope: address.scope,
      subject: readDocSubject(flags, address),
      owner: address.owner,
    },
    slug,
    docReadAudience(flags.flag('audience')),
  )
  if (!doc)
    throw new Error(
      `no ${address.scope} doc "${slug}"; use ${PLATFORM_SLUG} doc list --scope ${address.scope}`,
    )
  if (has('json'))
    presentation.log(JSON.stringify({ ...doc, ...effectiveDocSummary(doc.summary, doc.body) }))
  else
    presentation.write(
      `kind: ${doc.kind}\nform: ${doc.form ?? '-'}\nsummary: ${effectiveDocSummary(doc.summary, doc.body).summary} (${effectiveDocSummary(doc.summary, doc.body).summarySource})\narticle subject: ${doc.articleSubject ? `${doc.articleSubject.name} (${doc.articleSubject.id})` : '-'}\nrelated subjects: ${doc.relatedSubjects.map(({ name, id }) => `${name} (${id})`).join(', ') || '-'}\nsource files: ${doc.sourceFiles.join(', ') || '-'}\nchecked against: ${doc.checkedAgainstCommit ?? '-'}\nstatus: ${doc.status}\nreplacement: ${doc.replacement_slug ?? '-'}\naudiences: ${doc.audiences.join(',')}\nparent: ${doc.parent_slug ?? '-'}\n\n${doc.body}`,
    )
  return true
}

function clearedListOption(flags: DocFlags, value: string, clear: string): string[] | undefined {
  const { has } = flags
  if (has(value) && has(clear)) throw new Error(`use --${value} or --${clear}, not both`)
  if (has(clear)) return []
  return has(value) ? (flags.values?.(value) ?? []) : undefined
}

function summaryOption(flags: DocFlags): string | null | undefined {
  if (flags.has('no-summary')) return null
  if (!flags.has('summary')) return undefined
  return normalizeDocSummary(flags.flag('summary') ?? '')
}

function articleTreeOptions(flags: DocFlags) {
  const { has, flag } = flags
  if (has('form') && has('no-form')) throw new Error('use --form or --no-form, not both')
  const rawForm = flag('form')
  if (rawForm !== undefined && !DOC_FORMS.includes(rawForm as DocForm))
    throw new Error(`--form must be ${DOC_FORMS.join(' or ')}`)
  if (has('article-subject') && has('no-article-subject'))
    throw new Error('use --article-subject or --no-article-subject, not both')
  if (has('checked-at') && has('no-checked-at'))
    throw new Error('use --checked-at or --no-checked-at, not both')
  if (has('summary') && has('no-summary'))
    throw new Error('use --summary or --no-summary, not both')
  return {
    form: has('no-form') ? null : (rawForm as DocForm | undefined),
    articleSubject: has('no-article-subject') ? null : flag('article-subject'),
    relatedSubjects: clearedListOption(flags, 'related-subject', 'no-related-subjects'),
    sourceFiles: clearedListOption(flags, 'source-file', 'no-source-files'),
    checkedAgainstCommit: has('no-checked-at') ? null : flag('checked-at'),
    summary: summaryOption(flags),
  }
}

function setTreeOptions(flags: DocFlags): {
  audiences: ReturnType<typeof docAudiences>
  parentSlug: string | null | undefined
  position: number | undefined
  featured: boolean | undefined
  status: DocStatus | undefined
  kind: DocKind | undefined
  replacementSlug: string | null | undefined
  form: DocForm | null | undefined
  articleSubject: string | null | undefined
  relatedSubjects: string[] | undefined
  sourceFiles: string[] | undefined
  checkedAgainstCommit: string | null | undefined
  summary: string | null | undefined
} {
  const { has, flag } = flags
  const audiences = docAudiences(flag('audience'))
  if (has('parent') && has('no-parent')) throw new Error('use --parent or --no-parent, not both')
  const parentSlug = has('no-parent') ? null : has('parent') ? flag('parent') : undefined
  if (has('parent') && !parentSlug?.trim()) throw new Error('--parent requires a slug')
  if (has('featured') && has('no-featured'))
    throw new Error('use --featured or --no-featured, not both')
  const featured = has('featured') ? true : has('no-featured') ? false : undefined
  const replacementSlug = has('replacement') ? flag('replacement') : undefined
  if (has('replacement') && !replacementSlug?.trim())
    throw new Error('--replacement requires a slug')
  return {
    audiences,
    parentSlug,
    position: docPosition(flag('position')),
    featured,
    status: docStatus(flag('status')),
    kind: docKind(flag('kind')),
    replacementSlug,
    ...articleTreeOptions(flags),
  }
}

async function handleSetDocCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
  address: { scope: string | undefined; subject: string | null; owner: string | null },
  ports: DocCommandPorts,
): Promise<boolean> {
  if (sub === 'status') return handleStatusDocCommand(sub, argv, flags, presentation, address)
  if (sub !== 'set') return false
  const { has, flag } = flags
  const slug = argv[2]
  const title = flag('title')
  const reason = flag('reason')
  if (!slug || !address.scope || title === undefined || !reason?.trim()) {
    throw new Error(
      `${PLATFORM_SLUG} doc set <slug> --scope S [--subject X] [--cwd PATH] --title T --reason TEXT [--expect REVISION] (--file F | body on stdin)`,
    )
  }
  const canonTree = commandDocWriteTree(address.scope, address.subject, flags, presentation, ports)
  const body = flag('file')
    ? readFileSync(flag('file')!, 'utf8')
    : !presentation.stdinIsTTY
      ? await presentation.stdinText()
      : (() => {
          throw new Error('no body: pass --file F or pipe markdown on stdin')
        })()
  const delivery = docDelivery(flag('delivery'))
  const tree = setTreeOptions(flags)
  const forceInject = flag('force-inject')
  if (has('force-inject') && !forceInject?.trim())
    throw new Error('--force-inject requires a non-empty reason')
  const doc = await setDoc({
    ...address,
    scope: address.scope,
    slug,
    title,
    body,
    reason,
    author: flag('author'),
    forceInject,
    delivery,
    ...tree,
    expectedRevision: flag('expect'),
    canonTree,
    collectCanonLintInput: ports.collectCanonLintInput,
  })
  const root = repoRootForDoc(doc, canonTree?.root)
  const warnings = root ? checkDoc(body, { repoRoot: root }) : []
  const lintWarnings = storedDocWarnings(doc)
  if (has('json'))
    presentation.log(
      JSON.stringify({ ...doc, lintFindings: lintWarnings, warnings, tree: canonTree?.root }),
    )
  else {
    presentation.log(`set ${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`)
    printDocWriteWarnings(doc.writeWarnings, presentation)
    for (const warning of lintWarnings)
      presentation.error(`warning: line ${warning.line}: ${warning.message}`)
    for (const warning of warnings) presentation.error(`warning: ${warning.message}`)
  }
  return true
}

function printDocWriteWarnings(
  warnings: readonly string[] | undefined,
  presentation: Pick<DocPresentation, 'error'>,
): void {
  for (const warning of warnings ?? []) presentation.error(`warning: ${warning}`)
}

async function handleReorderDocCommand(
  sub: string,
  flags: DocFlags,
  presentation: DocPresentation,
  address: { scope: string | undefined; subject: string | null },
): Promise<boolean> {
  if (sub !== 'reorder') return false
  if (!address.scope)
    throw new Error(
      `${PLATFORM_SLUG} doc reorder --scope S [--subject X] [--parent SLUG|UUID] --slug SLUG|UUID...`,
    )
  const docs = listDocs({ scope: address.scope, subject: address.subject })
  const resolve = (value: string): string => {
    const row = docs.find((doc) => doc.slug === value || doc.record_id === value.toLowerCase())
    if (!row) throw new Error(`no ${address.scope}/${address.subject ?? '_'}/${value} document`)
    return row.record_id
  }
  const orderedIds = (flags.values?.('slug') ?? []).map(resolve)
  const result = await reorderDocs({
    scope: address.scope,
    subject: address.subject,
    parentId: flags.flag('parent') ? resolve(flags.flag('parent')!) : null,
    orderedIds,
  })
  presentation.log(
    flags.has('json') ? JSON.stringify(result) : `reordered ${orderedIds.length} documents`,
  )
  return true
}

async function handleStatusDocCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
  address: { scope: string | undefined; subject: string | null; owner: string | null },
): Promise<boolean> {
  if (sub !== 'status') return false
  const slug = argv[2]
  const status = docStatus(flags.flag('status'))
  const reason = flags.flag('reason')
  if (!slug || !address.scope || !status || !reason?.trim()) {
    throw new Error(
      `${PLATFORM_SLUG} doc status <slug> --scope S [--subject X] --status STATUS [--replacement SLUG] --reason TEXT [--expect REVISION]`,
    )
  }
  const result = await setDocStatus(
    address.scope,
    address.subject,
    slug,
    status,
    flags.flag('replacement'),
    {
      reason,
      author: flags.flag('author'),
      expectedRevision: flags.flag('expect'),
    },
    address.owner,
  )
  if (flags.has('json')) presentation.log(JSON.stringify(result))
  else
    presentation.log(
      `set status ${result.scope}/${result.subject ?? '_'}/${result.slug} ${result.status}`,
    )
  return true
}

function handledRevisionDocCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
  owner: string | null,
): boolean {
  if (sub !== 'revision') return false
  const scope = argv[2]
  const rawSubject = argv[3]
  const slug = argv[4]
  const revisionIdentifier = argv[5]
  if (!scope || rawSubject === undefined || !slug || !revisionIdentifier)
    throw new Error(`${PLATFORM_SLUG} doc revision <scope> <subject|-> <slug> <rev> --json`)
  const subject = rawSubject === '-' ? null : rawSubject
  if (flags.has('user') && (scope !== 'canon' || subject !== null)) {
    throw new Error('--user history address must be canon -')
  }
  const revision = readDocRevision(
    scope,
    subject,
    slug,
    resolveDocRevisionIdentifier(db(), revisionIdentifier),
    owner,
    docReadAudience(flags.flag('audience')),
  )
  if (flags.has('json')) {
    const user = cachedSignedInRecordUser()
    presentation.log(
      JSON.stringify({ ...revision, authorName: revisionAuthorName(revision.author, user) }),
    )
  } else presentation.log(revision.body)
  return true
}

async function handledReadOrRevisionDocCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
  address: { scope: string | undefined; subject: string | null; owner: string | null },
): Promise<boolean> {
  return (
    handledReadDocCommand(sub, argv, flags, presentation, address) ||
    handledRevisionDocCommand(sub, argv, flags, presentation, address.owner)
  )
}

async function handledWriteDocCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
  address: { scope: string | undefined; subject: string | null; owner: string | null },
  ports: DocCommandPorts,
): Promise<boolean> {
  return (
    (await handleSetDocCommand(sub, argv, flags, presentation, address, ports)) ||
    (await handleReorderDocCommand(sub, flags, presentation, address))
  )
}

export async function docCommand(
  sub: string,
  argv: string[],
  flags: DocFlags,
  presentation: DocPresentation,
  ports: DocCommandPorts,
): Promise<void> {
  const { has, flag } = flags
  validateUserAddress(has('user'), has('subject'))
  const scope = userAddressScope(has('user'), flag('scope'))
  const subject = has('user') ? null : (flag('subject') ?? null)
  const owner = has('user') ? await signedInDocOwner() : null
  const address = { scope, subject, owner }
  if (await handledEarlyDocCommand(sub, argv, flags, presentation)) return
  if (await handledReadOrRevisionDocCommand(sub, argv, flags, presentation, address)) return
  if (await handledWriteDocCommand(sub, argv, flags, presentation, address, ports)) return
  if (
    await handleDocConsumeCommand({
      sub,
      argv,
      scope,
      subject,
      flags,
      log: presentation.log,
      handoff: ports.consumeResumeHandoff,
    })
  )
    return
  if (sub === 'rm') {
    const slug = argv[2]
    const reason = flag('reason')
    if (!slug || !scope || !reason?.trim())
      throw new Error(
        `${PLATFORM_SLUG} doc rm <slug> --scope S [--subject X] [--cwd PATH] --reason TEXT [--expect REVISION]`,
      )
    const canonTree = commandDocWriteTree(scope, subject, flags, presentation, ports)
    const removed = await removeDoc(
      scope,
      subject,
      slug,
      {
        reason,
        author: flag('author'),
        expectedRevision: flag('expect'),
        canonTree,
        collectCanonLintInput: ports.collectCanonLintInput,
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
    if (!dir) throw new Error(`${PLATFORM_SLUG} doc ${sub} <dir>`)
    const reason = flag('reason')
    if (sub === 'import' && !reason?.trim())
      throw new Error(`${PLATFORM_SLUG} doc import <dir> --reason TEXT [--author NAME]`)
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
        `${PLATFORM_SLUG} doc ${sub} <scope> <subject|-> <slug>${sub === 'restore' ? ' <rev> --reason TEXT' : ''}`,
      )
    }
    const addressSubject = rawAddressSubject === '-' ? null : rawAddressSubject
    if (has('user') && (addressScope !== 'canon' || addressSubject !== null)) {
      throw new Error('--user history address must be canon -')
    }
    const revisions = listDocRevisions(addressScope, addressSubject, slug, owner)
    if (sub === 'history') {
      if (has('json')) {
        const user = cachedSignedInRecordUser()
        presentation.log(
          JSON.stringify(
            revisions.map((revision) => ({
              ...revision,
              authorName: revisionAuthorName(revision.author, user),
            })),
          ),
        )
      } else
        for (const revision of revisions) {
          presentation.log(
            `${revision.number}  ${revision.op.padEnd(8)} ${revision.kind.padEnd(8)} ${(revision.form ?? '-').padEnd(10)} ${revision.articleSubject?.name ?? '-'}  related:${revision.relatedSubjects.length} sources:${revision.sourceFiles.length}  ${revision.status.padEnd(11)} ${revision.replacement_slug ?? '-'}  ${revision.author}  ${revision.at}  ${revision.bytes} bytes  ${revision.reason}`,
          )
        }
      return
    }
    if (sub === 'diff') {
      const a = argv[5] ? resolveDocRevisionIdentifier(db(), argv[5]) : revisions[1]?.record_id
      const b = argv[6] ? resolveDocRevisionIdentifier(db(), argv[6]) : revisions[0]?.record_id
      if (!a || !b) throw new Error('doc diff needs two revisions; this address has fewer than two')
      const addressIds = new Set(revisions.map((revision) => revision.record_id))
      if (!addressIds.has(a) || !addressIds.has(b)) {
        throw new Error(
          `doc diff revisions must belong to ${addressScope}/${addressSubject ?? '_'}/${slug}`,
        )
      }
      presentation.write(diffDocRevisions(a, b, owner))
      return
    }
    const revisionIdentifier = argv[5]
    const reason = flag('reason')
    if (!revisionIdentifier || !reason?.trim()) {
      throw new Error(
        `${PLATFORM_SLUG} doc restore <scope> <subject|-> <slug> <rev> --reason TEXT [--expect REVISION]`,
      )
    }
    const restored = await restoreDoc(
      addressScope,
      addressSubject,
      slug,
      resolveDocRevisionIdentifier(db(), revisionIdentifier),
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
    `unknown: ${PLATFORM_SLUG} doc ${sub}. Try list | get | show | search | set | reorder | lint | warnings | consume | rm | history | revision | diff | restore | subjects | export | import | resumes`,
  )
}
