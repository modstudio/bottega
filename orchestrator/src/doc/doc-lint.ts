// concern: doc-lint
/** Pure lint rules for stored documents. */
import type { DocScope } from '../../../shared/docs.ts'
import { type CanonLintInput, lintCanonReferences } from '../canon/canon-lint.ts'
import { lintProse } from '../canon/prose-lint.ts'

export type DocLintFinding = {
  rule: string
  line: number
  message: string
  remedy: string
}

export type LintableDoc = {
  scope: DocScope | string
  subject: string | null
  slug: string
  body: string
  referenceProjects?: DocReferenceProject[]
}

export type DocReferenceProject = {
  name: string
  stack: string | null
  checkout: CanonLintInput | null
  unavailable?: string
}

export function docHasRepositoryReferences(body: string): boolean {
  return /`[^`\n]+`|\[[^\]]*\]\([^)]*\)|\b(?:bun|npm) run [a-z]/.test(body)
}

const DESIGN_HEADINGS = [
  '## What it is',
  '## Why this design',
  '## Build or buy',
  '## How it is measured',
] as const
const PROVISIONAL_HEADING = '## Provisional'

function referenceRemedy(rule: string): string {
  if (rule === 'doc/reference-unverifiable')
    return 'restore the registered project checkout or correct its registered path'
  if (rule === 'doc/reference-path')
    return 'cite a tracked repository path or remove the stale citation'
  if (rule === 'doc/reference-symbol') return 'cite an identifier declared by the referenced path'
  if (rule === 'doc/reference-heading')
    return 'cite a heading present in the referenced Markdown file'
  if (rule === 'doc/line-anchor') return 'replace the line anchor with a stable identifier'
  if (rule === 'doc/reference-code')
    return 'cite an identifier that occurs in tracked production source'
  return 'name a package script defined on the repository tree'
}

function mergedReferenceInput(inputs: CanonLintInput[]): CanonLintInput {
  const texts = new Map<string, string>()
  for (const input of inputs) {
    for (const source of [...input.sourceTexts, ...input.files]) {
      const previous = texts.get(source.path)
      texts.set(source.path, previous === undefined ? source.text : `${previous}\n${source.text}`)
    }
  }
  return {
    files: [],
    trackedPaths: [...new Set(inputs.flatMap(({ trackedPaths }) => trackedPaths))],
    packageScripts: [...new Set(inputs.flatMap(({ packageScripts }) => packageScripts))],
    sourceTexts: [...texts].map(([path, text]) => ({ path, text })),
  }
}

function referenceTargets(doc: LintableDoc): DocReferenceProject[] {
  if (!doc.referenceProjects) return []
  if (doc.scope === 'project') {
    return doc.referenceProjects.filter(({ name }) => name === doc.subject)
  }
  if (doc.scope === 'stack') {
    return doc.referenceProjects.filter(({ stack }) => stack === doc.subject)
  }
  return doc.referenceProjects
}

function referenceFindings(doc: LintableDoc): DocLintFinding[] {
  const targets = referenceTargets(doc)
  if (doc.scope === 'stack' && targets.length === 0) {
    return [
      {
        rule: 'doc/reference-unverifiable',
        line: 1,
        message: `no available registered project checkout for stack ${doc.subject}`,
        remedy: 'register or restore a project checkout for the named stack',
      },
    ]
  }
  const unavailable = targets.filter(({ checkout }) => checkout === null)
  const findings: DocLintFinding[] = unavailable.map(({ name, unavailable: detail }) => ({
    rule: 'doc/reference-unverifiable',
    line: 1,
    message: detail
      ? `registered project ${name} checkout could not be inspected: ${detail}`
      : `registered project ${name} checkout is missing`,
    remedy: referenceRemedy('doc/reference-unverifiable'),
  }))
  const available = targets.flatMap(({ checkout }) => (checkout ? [checkout] : []))
  if (!available.length) return findings
  return [
    ...findings,
    ...lintCanonReferences(
      { path: `doc/${doc.scope}/${doc.subject ?? '_'}/${doc.slug}.md`, text: doc.body },
      mergedReferenceInput(available),
    ).map((finding) => {
      const rule = finding.rule.replace(/^canon\//, 'doc/')
      return {
        rule,
        line: finding.line,
        message: finding.message,
        remedy: referenceRemedy(rule),
      }
    }),
  ]
}

function designHeadingFindings(body: string): DocLintFinding[] {
  const lines = body.split(/\r?\n/)
  const positions = DESIGN_HEADINGS.map((heading) =>
    lines.findIndex((line) => line.trimEnd() === heading),
  )
  const provisional = lines.findIndex((line) => line.trimEnd() === PROVISIONAL_HEADING)
  const missing = DESIGN_HEADINGS.filter((_, index) => positions[index] === -1)
  if (missing.length) {
    return [
      {
        rule: 'doc/design-headings',
        line: 1,
        message: `missing ${missing.join(', ')}`,
        remedy:
          'add the required design headings in order: What it is, Why this design, Build or buy, optional Provisional, How it is measured',
      },
    ]
  }
  const ordered = positions.every(
    (position, index) => index === 0 || position > positions[index - 1]!,
  )
  const provisionalOrdered =
    provisional === -1 || (provisional > positions[2]! && provisional < positions[3]!)
  if (ordered && provisionalOrdered) return []
  return [
    {
      rule: 'doc/design-headings',
      line: 1,
      message: 'design record headings are out of order',
      remedy:
        'order the headings as What it is, Why this design, Build or buy, optional Provisional, How it is measured',
    },
  ]
}

export function lintDoc(doc: LintableDoc): DocLintFinding[] {
  if (doc.scope === 'resume' || doc.scope === 'canon' || doc.scope === 'settings') return []
  const findings = lintProse(doc.body).map((finding) => ({
    ...finding,
    rule: `doc/${finding.rule}`,
  }))
  if (doc.referenceProjects) findings.push(...referenceFindings(doc))
  if (doc.slug.startsWith('design-')) findings.push(...designHeadingFindings(doc.body))
  return findings.sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.line - b.line || a.message.localeCompare(b.message),
  )
}

/** A doc update may keep legacy findings, but may not add another rule/message pair. */
export function introducedDocFindings(
  baseline: DocLintFinding[],
  findings: DocLintFinding[],
): DocLintFinding[] {
  const remaining = new Map<string, number>()
  const key = (finding: DocLintFinding) => JSON.stringify([finding.rule, finding.message])
  for (const finding of baseline) {
    const fingerprint = key(finding)
    remaining.set(fingerprint, (remaining.get(fingerprint) ?? 0) + 1)
  }
  return findings.filter((finding) => {
    const fingerprint = key(finding)
    const count = remaining.get(fingerprint) ?? 0
    if (count === 0) return true
    remaining.set(fingerprint, count - 1)
    return false
  })
}

export function docLintRefusal(
  doc: Pick<LintableDoc, 'scope' | 'subject' | 'slug'>,
  findings: DocLintFinding[],
): string | null {
  if (!findings.length) return null
  const address = `${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`
  return (
    `refusing doc ${address}:\n` +
    findings
      .map(
        (finding) =>
          `- ${finding.rule} line ${finding.line}: ${finding.message}\n  remedy: ${finding.remedy}`,
      )
      .join('\n')
  )
}
