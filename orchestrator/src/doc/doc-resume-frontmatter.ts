// concern: doc-resume-frontmatter
/** Parses resume-brief YAML frontmatter by regex so consume and list can keep the rest of the artifact byte-for-byte. */

const RESUME_FRONTMATTER_KEYS = [
  'status',
  'epic',
  'task',
  'project',
  'written',
  'consumed',
  'consumed_by',
] as const
export type ResumeFrontmatter = { [K in (typeof RESUME_FRONTMATTER_KEYS)[number]]?: string }
type ResolvedStatus = {
  value: string
  valueStart: number
  valueEnd: number
  occurrences: number
}

/**
 * Frontmatter is matched by regex, not parsed as YAML, so consumeDoc can preserve
 * the rest of the recovery artifact byte-for-byte. A column-zero `status:` inside
 * a quoted multi-line scalar is therefore read as a key; adopting a YAML parser is
 * a separate decision. The last column-zero occurrence wins, matching the prior
 * parser behavior and the common YAML-loader treatment of duplicate keys. When
 * there is no column-zero status, the last nested occurrence wins instead.
 */
function resolveStatus(yaml: string): ResolvedStatus | null {
  const topLevel = /(^|\r?\n)(status[ \t]*:[ \t]*)([^\r\n]*)(?=\r?\n|$)/g
  const nested = /(^|\r?\n)([ \t]+status[ \t]*:[ \t]*)([^\r\n]*)(?=\r?\n|$)/g
  const matches = [...yaml.matchAll(topLevel)]
  const governing = matches.length ? matches : [...yaml.matchAll(nested)]
  let resolved: ResolvedStatus | null = null
  let occurrences = 0
  for (const match of governing) {
    occurrences++
    const raw = match[3]!
    const valueStart = match.index! + match[1]!.length + match[2]!.length
    resolved = {
      value: raw.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'),
      valueStart,
      valueEnd: valueStart + raw.length,
      occurrences,
    }
  }
  if (resolved) resolved.occurrences = occurrences
  return resolved
}

/**
 * Status of a resume brief lives in the body's opening YAML, not in the
 * address. An absent block is not open; an unreadable line is skipped rather
 * than making the whole brief disappear.
 */
export function resumeFrontmatter(body: string): {
  top: ResumeFrontmatter
  nested: ResumeFrontmatter
  status: ResolvedStatus | null
} | null {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return null
  const top: ResumeFrontmatter = {}
  const nested: ResumeFrontmatter = {}
  const known = new Set<string>(RESUME_FRONTMATTER_KEYS)
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue
    const kv = line.match(/^([ \t]*)([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (!kv) continue
    const key = kv[2]!
    if (!known.has(key)) continue
    let value = kv[3]!
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    const target = kv[1] ? nested : top
    target[key as keyof ResumeFrontmatter] = value
  }
  const status = resolveStatus(match[1]!)
  return { top, nested, status }
}

export function parseResumeFrontmatter(body: string): ResumeFrontmatter | null {
  const parsed = resumeFrontmatter(body)
  if (!parsed) return null
  return {
    ...parsed.nested,
    ...parsed.top,
    ...(parsed.status ? { status: parsed.status.value } : {}),
  }
}

/** Single largest unit: Ns, Nm, Nh, Nd. */
export function resumeAge(fromMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - fromMs)
  const s = Math.floor(delta / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
