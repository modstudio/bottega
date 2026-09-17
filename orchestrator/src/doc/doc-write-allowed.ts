// concern: doc-write-allowed
/** Pure document write decisions. Must not know stores, filesystems, HTTP, or CLI. */
import { composeCanonRows } from '../canon/canon-hydrate.ts'
import type { CanonSourceText } from '../canon/canon-lint.ts'
import { decideCanonWrite } from '../canon/canon-write-gate.ts'
import { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } from '../pack-budget.ts'

export const RECORD_WRITE_REMEDY = 'cleared by: orch record doctor'

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
      input.projectSlugs
        .filter((slug) => input.subject === null || slug !== input.slug)
        .map((slug) => ({ slug, body: '', subject: input.subject ?? '' })),
    )
    if (input.subject === null) {
      composeCanonRows(
        [{ slug: input.slug, body: '', subject: null }],
        input.projectSlugs.map((slug) => ({ slug, body: '', subject: '' })),
      )
    } else {
      composeCanonRows(
        input.globalSlugs.map((slug) => ({ slug, body: '', subject: null })),
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
  const findings = decideCanonWrite({
    current: input.current,
    next: input.next,
    trackedPaths: input.trackedPaths,
    packageScripts: input.packageScripts,
    sourceTexts: input.sourceTexts,
  })
  if (!findings.length) return null
  return (
    `refusing canon write; introduced ${findings.length} finding${findings.length === 1 ? '' : 's'}:\n` +
    findings
      .map((finding) => `${finding.file}:${finding.line} ${finding.rule} ${finding.message}`)
      .join('\n')
  )
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
