// concern: doc-write-allowed
/** Pure document write decisions. Must not know stores, filesystems, HTTP, or CLI. */
import {
  DOC_SCOPE_ALLOWS_OWNER,
  type DocScope,
  docScopeHasProjectSubject,
} from '../../../shared/docs.ts'
import { composeCanonRows } from '../canon/canon-hydrate.ts'
import type { CanonFinding, CanonSourceText } from '../canon/canon-lint.ts'
import { decideNextCanonSet } from '../canon/canon-write-gate.ts'
import { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } from '../canon/pack-budget.ts'
import { refuseSettingsBody } from '../settings/settings.ts'
import { docLintRefusal, introducedDocFindings, type LintableDoc, lintDoc } from './doc-lint.ts'

export { refuseSettingsBody }

export const RECORD_WRITE_REMEDY = 'cleared by: orch record doctor'
export const MISSING_HOSTED_REVISION_REMEDY =
  'cleared by: repair the document revision state, then retry the write'

export type DocDelivery = 'inject' | 'demand'
export type DocRevisionOp =
  | 'create'
  | 'set'
  | 'consume'
  | 'delete'
  | 'restore'
  | 'import'
  | 'backfill'

export type CanonRow = { slug: string; body: string }
export type CanonWriteTree = { project: { name: string }; root: string }
export { composeCanonRows }

/** Owned rows are visible only to their signed-in owner; unowned rows remain shared. */
export function ownerVisible(owner: string | null, signedInUserId: string | null): boolean {
  return owner === null || owner === signedInUserId
}

export type GlobalCanonWriteTarget = {
  name: string
  path: string
  settings: { managedContext?: boolean }
}

export function globalCanonWriteTargets(
  registered: GlobalCanonWriteTarget[],
): (GlobalCanonWriteTarget | null)[] {
  const optedIn = registered.filter((project) => project.settings.managedContext === true)
  return optedIn.length ? optedIn : [null]
}

/** User canon is checked against every managed project, or by itself when none opt in. */
export const userCanonWriteTargets = globalCanonWriteTargets

export function canonFindingsRefusal(findings: CanonFinding[]): string | null {
  if (!findings.length) return null
  return (
    `refusing canon write; introduced ${findings.length} finding${findings.length === 1 ? '' : 's'}:\n` +
    findings
      .map((finding) => `${finding.file}:${finding.line} ${finding.rule} ${finding.message}`)
      .join('\n')
  )
}

export function canonRemovalRefusal(findings: CanonFinding[]): string | null {
  if (!findings.length) return null
  return (
    `refusing canon removal; introduced ${findings.length} reference finding${findings.length === 1 ? '' : 's'}:\n` +
    findings
      .map((finding) => `${finding.file}:${finding.line} ${finding.rule} ${finding.message}`)
      .join('\n') +
    '\ncleared by: update or remove the named citations first, then retry the removal'
  )
}

export function importedDocDelivery(scope: string): 'demand' | undefined {
  return scope === 'project' || scope === 'global' ? 'demand' : undefined
}

export function forcedDocDelivery(scope: string): 'demand' | null {
  return scope === 'canon' || scope === 'settings' ? 'demand' : null
}

export function docWriteProjectName(scope: string, subject: string | null): string | null {
  return docScopeHasProjectSubject(scope) ? subject : null
}

export function refuseOwnedDocAddress(
  scope: string,
  subject: string | null,
  owner: string | null | undefined,
): string | null {
  if (!owner) return null
  if (DOC_SCOPE_ALLOWS_OWNER[scope as DocScope] === true && subject === null) return null
  return (
    'owned docs require scope canon or settings and no subject\n' +
    'cleared by: omit the subject and use an owner only with canon or settings'
  )
}

export function refuseSettingsAddress(
  scope: string,
  subject: string | null,
  owner: string | null | undefined,
): string | null {
  if (scope !== 'settings') return null
  if (Boolean(owner) === (subject === null)) return null
  return (
    'settings docs require an owner and no subject, or a project subject and no owner\n' +
    'cleared by: orch settings import --user or --project <name>'
  )
}

export type DocRevisionDecision = { allow: true } | { allow: false; reason: string }

/** Decides optimistic document writes without knowing either backing store. */
export function decideDocRevisionWrite(input: {
  expected?: string
  current: string | null
  isCreate: boolean
  scope: string
}): DocRevisionDecision {
  if (!input.isCreate && input.scope === 'canon' && input.current === null) {
    return {
      allow: false,
      reason:
        "refusing canon write: this row's latest revision is missing, so its revision cannot be checked\n" +
        MISSING_HOSTED_REVISION_REMEDY,
    }
  }
  if (input.isCreate && input.expected === undefined) return { allow: true }
  if (
    !input.isCreate &&
    input.scope !== 'canon' &&
    input.scope !== 'settings' &&
    input.expected === undefined
  ) {
    return { allow: true }
  }

  const current = input.current ?? '(no current revision)'
  if (!input.isCreate && input.expected === undefined) {
    return {
      allow: false,
      reason:
        `refusing ${input.scope} update at current revision ${current}; pass --expect ${current}\n` +
        're-read with orch doc get and re-apply the edit',
    }
  }
  if (input.expected !== input.current) {
    return {
      allow: false,
      reason:
        `refusing stale document update: expected revision ${input.expected}, current revision ${current}\n` +
        're-read with orch doc get and re-apply the edit',
    }
  }
  return { allow: true }
}

/** Hosted services have no checkout inventory, so they enforce every pure rule except references. */
export function recordDocLintRefusal(
  next: Pick<LintableDoc, 'scope' | 'subject' | 'slug' | 'body'>,
  current?: Pick<LintableDoc, 'scope' | 'subject' | 'slug' | 'body'>,
): string | null {
  const findings = lintDoc(next)
  const introduced = current ? introducedDocFindings(lintDoc(current), findings) : findings
  return docLintRefusal(next, introduced)
}

export function refuseProjectOrGlobalInject(scope: string, delivery: DocDelivery): string | null {
  if ((scope === 'project' || scope === 'global') && delivery === 'inject') {
    return (
      `refusing inject ${scope} document: inject operator docs describe this estate; software-building instructions are canon\n` +
      'cleared by: make the instruction canon, or write the operator document with delivery demand'
    )
  }
  return null
}

export function refuseOversizedInject(input: {
  delivery: DocDelivery
  body: string
  forceInject?: string
  packBytes: number
}): string | null {
  if (input.delivery !== 'inject') return null
  const bytes = Buffer.byteLength(input.body)
  if (bytes <= MAX_INJECT_DOC_BYTES || input.forceInject?.trim()) return null
  const headroom = DEFAULT_PACK_BYTES - input.packBytes
  return (
    `inject document is ${bytes} bytes; threshold is ${MAX_INJECT_DOC_BYTES} bytes; ` +
    `current pack is ${input.packBytes} bytes with ${headroom} bytes headroom\n` +
    'invariant: oversized narrative belongs on demand so an accepted write cannot break the canon pack gate\n' +
    'cleared by: use --delivery demand, shorten the document, or pass --force-inject "<reason>"'
  )
}

function refuseCanonPathCollision(input: {
  scope: string
  subject: string | null
  slug: string
  globalSlugs: string[]
  projectSlugs: string[]
}): string | null {
  if (input.scope !== 'canon') return null
  try {
    composeCanonRows(
      input.globalSlugs
        .filter((slug) => input.subject !== null || slug !== input.slug)
        .map((slug) => ({ slug, body: '', subject: null })),
      [],
      input.projectSlugs
        .filter((slug) => input.subject === null || slug !== input.slug)
        .map((slug) => ({ slug, body: '', subject: input.subject ?? '' })),
    )
    if (input.subject === null) {
      composeCanonRows(
        [{ slug: input.slug, body: '', subject: null }],
        [],
        input.projectSlugs.map((slug) => ({ slug, body: '', subject: '' })),
      )
    } else {
      composeCanonRows(
        input.globalSlugs.map((slug) => ({ slug, body: '', subject: null })),
        [],
        [{ slug: input.slug, body: '', subject: input.subject }],
      )
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return null
}

export function refuseCanonWrite(input: {
  current: CanonRow[]
  next: CanonRow[]
  trackedPaths?: string[]
  packageScripts?: string[]
  sourceTexts?: CanonSourceText[]
}): string | null {
  const findings = decideNextCanonSet({
    current: input.current,
    next: input.next,
    trackedPaths: input.trackedPaths,
    packageScripts: input.packageScripts,
    sourceTexts: input.sourceTexts,
  })
  return canonFindingsRefusal(findings)
}

export function refuseDocWrite(input: {
  scope: string
  subject: string | null
  slug: string
  body: string
  delivery: DocDelivery
  forceInject?: string
  packBytes: number
  globalCanonSlugs: string[]
  projectCanonSlugs: string[]
  currentCanon: CanonRow[]
  nextCanon: CanonRow[]
  trackedPaths?: string[]
  packageScripts?: string[]
  sourceTexts?: CanonSourceText[]
  allowCanonBootstrap?: boolean
}): string | null {
  return (
    refuseProjectOrGlobalInject(input.scope, input.delivery) ??
    refuseOversizedInject(input) ??
    refuseSettingsBody(input.scope, input.body) ??
    refuseCanonPathCollision({
      scope: input.scope,
      subject: input.subject,
      slug: input.slug,
      globalSlugs: input.globalCanonSlugs,
      projectSlugs: input.projectCanonSlugs,
    }) ??
    (input.scope === 'canon' && !input.allowCanonBootstrap
      ? refuseCanonWrite({
          current: input.currentCanon,
          next: input.nextCanon,
          trackedPaths: input.trackedPaths,
          packageScripts: input.packageScripts,
          sourceTexts: input.sourceTexts,
        })
      : null)
  )
}

export function consumeDocBody(
  body: string,
  consumedAt: string,
  consumedBy: string,
): { body: string; alreadyConsumed: boolean } {
  const frontmatter = body.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/)
  if (!frontmatter) throw new Error('document has no YAML frontmatter')
  const newline = frontmatter[1]!
  let yaml = frontmatter[2]!
  const field = (name: string) =>
    new RegExp(`(^|\\r?\\n)([ \\t]*${name}[ \\t]*:[ \\t]*)([^\\r\\n]*)(?=\\r?\\n|$)`, 'm')
  const resolvedStatus = () => resolveStatus(yaml)
  const status = resolvedStatus()
  if (!status) throw new Error('document has no status field in its YAML frontmatter')
  if (status.value === 'consumed') return { body, alreadyConsumed: true }

  yaml = yaml.slice(0, status.valueStart) + 'consumed' + yaml.slice(status.valueEnd)
  const stamps = [
    ['consumed', consumedAt],
    ['consumed_by', consumedBy],
  ] as const
  const missing: string[] = []
  for (const [name, value] of stamps) {
    const pattern = field(name)
    if (pattern.test(yaml)) yaml = yaml.replace(pattern, `$1$2${value}`)
    else missing.push(`${name}: ${value}`)
  }
  if (missing.length) {
    const consumedStatus = resolvedStatus()!
    yaml =
      yaml.slice(0, consumedStatus.valueEnd) +
      newline +
      missing.join(newline) +
      yaml.slice(consumedStatus.valueEnd)
  }
  const contentStart = frontmatter.index! + 3 + newline.length
  return {
    body: body.slice(0, contentStart) + yaml + body.slice(contentStart + frontmatter[2]!.length),
    alreadyConsumed: false,
  }
}

function resolveStatus(yaml: string): {
  value: string
  valueStart: number
  valueEnd: number
} | null {
  const topLevel = /(^|\r?\n)(status[ \t]*:[ \t]*)([^\r\n]*)(?=\r?\n|$)/g
  const nested = /(^|\r?\n)([ \t]+status[ \t]*:[ \t]*)([^\r\n]*)(?=\r?\n|$)/g
  const matches = [...yaml.matchAll(topLevel)]
  const governing = matches.length ? matches : [...yaml.matchAll(nested)]
  let resolved: { value: string; valueStart: number; valueEnd: number } | null = null
  for (const match of governing) {
    const raw = match[3]!
    const valueStart = match.index! + match[1]!.length + match[2]!.length
    resolved = {
      value: raw.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'),
      valueStart,
      valueEnd: valueStart + raw.length,
    }
  }
  return resolved
}
