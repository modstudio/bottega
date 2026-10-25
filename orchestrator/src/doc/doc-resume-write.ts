// concern: doc-resume-write
/** Decides whether a resume brief write preserves its required shape and consumption handoff. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  parseResumeFrontmatter,
  type ResumeFrontmatter,
  type resumeFrontmatter,
} from './doc-resume-frontmatter.ts'

export type OpenResumeViolation = {
  offendingText: string
  remedy: string
}

export function resumeConsumptionWriteRefusal(
  input: { scope: string; subject?: string | null; slug: string; body: string },
  priorBody: string | null,
): string | null {
  if (input.scope !== 'resume' || parseResumeFrontmatter(input.body)?.status !== 'consumed')
    return null
  if (priorBody && parseResumeFrontmatter(priorBody)?.status === 'consumed') return null
  return (
    `refusing resume document write: set_doc cannot change status to consumed unless the stored brief is already consumed\n` +
    `cleared by: consume it with MCP consume_doc or ${PLATFORM_SLUG} doc consume ${input.slug} --scope resume --subject ${input.subject ?? '<subject>'}, which marks it consumed and hands its author's runs to this session`
  )
}

const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const TRACKER_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/
const NEXT_ACTION_LABEL =
  /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:[*_]{1,3})?NEXT ACTION(?:[*_]{1,3})?:[ \t]*\S.*$/i
const NEXT_ACTION_HEADING = /^[ \t]{0,3}#{1,6}[ \t]+NEXT ACTION[ \t]*#*[ \t]*$/i
const PATH_TOKEN = /\/?[A-Za-z0-9._~:@%+=-]+(?:\/[A-Za-z0-9._~:@%+=-]+)*\/?/g
const URL_SPAN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g

function isScratchLocation(path: string): boolean {
  return (
    path.startsWith('/tmp/') ||
    path.startsWith('/private/tmp/') ||
    path.startsWith('/var/folders/') ||
    path.includes('/orchestrator/runs/') ||
    (path.includes('/') && path.split('/').includes('scratchpad'))
  )
}

function missingField(field: 'project' | 'written'): OpenResumeViolation {
  return {
    offendingText: `${field}: <missing or empty>`,
    remedy: `supply a non-empty top-level ${field} field`,
  }
}

function bodyAfterFrontmatter(body: string): string {
  const frontmatter = body.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0]
  return frontmatter ? body.slice(frontmatter.length) : body
}

function hasNextAction(body: string): boolean {
  const lines = bodyAfterFrontmatter(body).split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (NEXT_ACTION_LABEL.test(line)) return true
    if (!NEXT_ACTION_HEADING.test(line)) continue
    if (lines.slice(index + 1).some((following) => following.trim().length > 0)) return true
  }
  return false
}

function trackerViolations(frontmatter: ResumeFrontmatter): OpenResumeViolation[] {
  if (!('epic' in frontmatter) && !('task' in frontmatter)) {
    return [
      {
        offendingText: 'epic or task: <missing>',
        remedy: 'supply a top-level epic or task field holding a tracker key',
      },
    ]
  }
  const violations: OpenResumeViolation[] = []
  for (const field of ['epic', 'task'] as const) {
    if (!(field in frontmatter)) continue
    const value = frontmatter[field] ?? ''
    if (!TRACKER_KEY.test(value.trim())) {
      violations.push({
        offendingText: `${field}: ${value}`,
        remedy: `supply ${field} as a tracker key such as DEV-1208`,
      })
    }
  }
  return violations
}

function scratchLocationViolations(body: string): OpenResumeViolation[] {
  const urlSpans = [...body.matchAll(URL_SPAN)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }))
  const violations: OpenResumeViolation[] = []
  for (const match of body.matchAll(PATH_TOKEN)) {
    if (urlSpans.some(({ start, end }) => match.index! >= start && match.index! < end)) continue
    if (!isScratchLocation(match[0])) continue
    violations.push({
      offendingText: match[0],
      remedy: 'remove the scratch location and name a durable repository or doc-store location',
    })
  }
  return violations
}

/** Return every reason an open resume brief cannot be written. */
export function openResumeViolations(
  body: string,
  frontmatter: ResumeFrontmatter,
): OpenResumeViolation[] {
  const violations = trackerViolations(frontmatter)
  for (const field of ['project', 'written'] as const) {
    if (!frontmatter[field]?.trim()) violations.push(missingField(field))
  }
  const written = frontmatter.written?.trim()
  if (written && (!ISO_8601_TIMESTAMP.test(written) || !Number.isFinite(Date.parse(written)))) {
    violations.push({
      offendingText: `written: ${frontmatter.written}`,
      remedy: 'supply written as an ISO 8601 timestamp with a timezone',
    })
  }
  if (!hasNextAction(body)) {
    violations.push({
      offendingText: 'NEXT ACTION: <missing>',
      remedy: 'add an explicit NEXT ACTION line',
    })
  }
  violations.push(...scratchLocationViolations(body))
  return violations
}

/** Apply the complete resume-body write rule after the adapter parses its frontmatter. */
export function resumeWriteRefusal(
  slug: string,
  body: string,
  frontmatter: ReturnType<typeof resumeFrontmatter>,
): string | null {
  if (!frontmatter?.top.status) {
    return `resume doc "${slug}" requires readable top-level YAML frontmatter in the shape "status: open" or "status: consumed"`
  }
  if (frontmatter.status?.occurrences && frontmatter.status.occurrences > 1) {
    return `resume doc "${slug}" has more than one top-level status field`
  }
  const status = frontmatter.top.status
  if (status !== 'open' && status !== 'consumed') {
    return `resume doc "${slug}" has unrecognized status "${status}"; permitted values are "open" and "consumed"`
  }
  if (status === 'consumed') return null
  const violations = openResumeViolations(body, frontmatter.top)
  if (!violations.length) return null
  return [
    `resume doc "${slug}" cannot be written open:`,
    ...violations.map(
      ({ offendingText, remedy }) => `- ${JSON.stringify(offendingText)}; cleared by: ${remedy}`,
    ),
  ].join('\n')
}

/** Explain how to recover a historical body that cannot become the live open brief. */
export function resumeRestoreRefusal(refusal: string | null): string | null {
  if (!refusal) return null
  return `${refusal}\nThe revision remains readable; cleared by: read the revision, correct its body, then write it with ${PLATFORM_SLUG} doc set.`
}
