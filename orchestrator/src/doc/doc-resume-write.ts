// concern: doc-resume-write
/** Decides whether an open resume brief has the metadata and durable handoff shape it requires. */

import type { ResumeFrontmatter, resumeFrontmatter } from './doc-resume-frontmatter.ts'

export type OpenResumeViolation = {
  offendingText: string
  remedy: string
}

const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const NEXT_ACTION_LINE =
  /^[ \t]*(?:#{1,6}[ \t]+|(?:(?:[-+*]|\d+[.)])[ \t]+))?(?:[*_]{1,3})?NEXT ACTION\b/im
const SCRATCH_LOCATION =
  /(?:\/private\/tmp\/|\/tmp\/|\/var\/folders\/|\/orchestrator\/runs\/|(?:^|\/)scratchpad(?:\/|$))[^\s`'"\][(){}<>,]*/gim

function missingField(field: 'epic' | 'project' | 'written'): OpenResumeViolation {
  return {
    offendingText: `${field}: <missing or empty>`,
    remedy: `supply a non-empty top-level ${field} field`,
  }
}

/** Return every reason an open resume brief cannot be written. */
export function openResumeViolations(
  body: string,
  frontmatter: ResumeFrontmatter,
): OpenResumeViolation[] {
  const violations: OpenResumeViolation[] = []
  for (const field of ['epic', 'project', 'written'] as const) {
    if (!frontmatter[field]?.trim()) violations.push(missingField(field))
  }
  const written = frontmatter.written?.trim()
  if (written && (!ISO_8601_TIMESTAMP.test(written) || !Number.isFinite(Date.parse(written)))) {
    violations.push({
      offendingText: `written: ${frontmatter.written}`,
      remedy: 'supply written as an ISO 8601 timestamp with a timezone',
    })
  }
  if (!NEXT_ACTION_LINE.test(body)) {
    violations.push({
      offendingText: 'NEXT ACTION: <missing>',
      remedy: 'add an explicit NEXT ACTION line',
    })
  }
  for (const match of body.matchAll(SCRATCH_LOCATION)) {
    violations.push({
      offendingText: match[0],
      remedy: 'remove the scratch location and name a durable repository or doc-store location',
    })
  }
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
  return `${refusal}\nThe revision remains readable; cleared by: read the revision, correct its body, then write it with bottega doc set.`
}
