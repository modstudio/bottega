// concern: outbox-sanitize
/** Withholds secret-shaped free-text leaves from hosted outbox payloads. Must not know Postgres. */
import { redactSecretShaped, WITHHELD_SECRET_SHAPED } from '../../../shared/secret-shaped.ts'
import { serializeOutboxPayload } from './outbox-serialize.ts'

export type OutboxSanitizeKind =
  | 'run'
  | 'score'
  | 'question'
  | 'review'
  | 'review_lens'
  | 'review_finding'
  | 'review_read'
  | 'release'
  | 'landing'
  | 'landing_override'
  | 'pull_request_ci'
  | 'contention'
  | 'test_flake'
  | 'branch_disposal'

type SecretLeaf = {
  at: string
  style: 'value' | 'elements' | 'walk'
  recordedAs?: string
  each?: string
}

const LEAVES: Record<OutboxSanitizeKind, readonly SecretLeaf[]> = {
  run: [
    { at: 'promptHead', style: 'value' },
    { at: 'label', style: 'value' },
    { at: 'error', style: 'value' },
    { at: 'routeReason', style: 'value' },
    { at: 'closeOutDetail', style: 'value' },
    { at: 'evidenceUnvoid.note', style: 'value' },
    { at: 'reviewProvenance', style: 'walk' },
  ],
  score: [{ at: 'note', style: 'value' }],
  question: [
    { at: 'question', style: 'value' },
    { at: 'options', style: 'elements' },
    { at: 'recommendation', style: 'value' },
    { at: 'why', style: 'value' },
    { at: 'answer', style: 'value' },
    { at: 'answerBasis', style: 'value', recordedAs: 'answer_basis' },
    { at: 'overturnReason', style: 'value', recordedAs: 'overturn_reason' },
    { at: 'replacement', style: 'value' },
    { at: 'filedRef', style: 'value', recordedAs: 'filed_ref' },
    { at: 'filedLabel', style: 'value', recordedAs: 'filed_label' },
    { at: 'audits', style: 'value', each: 'reason', recordedAs: 'audit_reason' },
  ],
  review: [
    { at: 'tierReasons', style: 'elements' },
    { at: 'tierReason', style: 'value' },
    { at: 'commitMessage', style: 'value' },
    { at: 'outdatedReason', style: 'value' },
  ],
  review_lens: [
    { at: 'standardsRead', style: 'elements' },
    { at: 'filesCovered', style: 'elements' },
    { at: 'commandsRun', style: 'elements' },
    { at: 'couldNotVerify', style: 'elements' },
    { at: 'mcpTools', style: 'elements' },
    { at: 'docsRead', style: 'elements' },
    { at: 'substitutes', style: 'elements' },
  ],
  review_finding: [
    { at: 'location', style: 'value' },
    { at: 'evidence', style: 'value' },
    { at: 'proposedCorrection', style: 'value' },
  ],
  review_read: [{ at: 'note', style: 'value' }],
  release: [
    { at: 'rollbackReason', style: 'value', recordedAs: 'rollback_reason' },
    { at: 'behindTrunkReason', style: 'value', recordedAs: 'behind_trunk_reason' },
    { at: 'warning', style: 'value' },
  ],
  landing: [
    { at: 'error', style: 'value' },
    { at: 'steps', style: 'walk' },
  ],
  landing_override: [{ at: 'reason', style: 'value' }],
  pull_request_ci: [
    { at: 'error', style: 'value' },
    { at: 'workflowName', style: 'value' },
    { at: 'failedJobs', style: 'elements' },
  ],
  contention: [{ at: 'cause', style: 'value' }],
  test_flake: [
    { at: 'test', style: 'value' },
    { at: 'file', style: 'value' },
    { at: 'signal', style: 'value' },
  ],
  branch_disposal: [{ at: 'note', style: 'value' }],
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload }
}

function wellFormedText(text: string): string {
  return text.toWellFormed().replaceAll('\0', '\uFFFD')
}

function replaceUnstorableCodePoints(value: unknown): unknown {
  if (typeof value === 'string') return wellFormedText(value)
  if (Array.isArray(value)) return value.map(replaceUnstorableCodePoints)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      wellFormedText(key),
      replaceUnstorableCodePoints(child),
    ]),
  )
}

function getAt(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root
  for (const part of path.split('.')) {
    if (!isPlainObject(current)) return undefined
    current = current[part]
  }
  return current
}

function setAt(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  const last = parts.pop()
  if (last === undefined) return
  let current: unknown = root
  for (const part of parts) {
    if (!isPlainObject(current)) return
    current = current[part]
  }
  if (isPlainObject(current)) current[last] = value
}

function wholeFieldTexts(value: unknown): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return [String(value)]
}

function redactOutboxText(text: string): { text: string; rules: string[] } {
  return redactSecretShaped(text, { exemptEvidenceTokens: true })
}

function firstRuleInTexts(
  texts: string[],
  acceptsRule: (rule: string) => boolean = () => true,
): string | null {
  for (const text of texts) {
    const rule = redactOutboxText(text).rules.find(acceptsRule)
    if (rule) return rule
  }
  return null
}

function walkStrings(
  value: unknown,
  path: string,
  visit: (path: string, text: string, replace: (next: string) => void) => void,
): void {
  if (typeof value === 'string') return
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const next = `${path}[${index}]`
      if (typeof child === 'string') {
        visit(next, child, (replacement) => {
          value[index] = replacement
        })
      } else walkStrings(child, next, visit)
    }
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    const next = `${path}.${key}`
    if (typeof child === 'string') {
      visit(next, child, (replacement) => {
        value[key] = replacement
      })
    } else walkStrings(child, next, visit)
  }
}

function detachAt(payload: Record<string, unknown>, path: string): unknown {
  const current = getAt(payload, path)
  if (current == null || typeof current !== 'object') return current
  const cloned = cloneJson(current)
  setAt(payload, path, cloned)
  return cloned
}

function applyValueLeaf(
  payload: Record<string, unknown>,
  leaf: SecretLeaf,
  onMatch: (path: string, rule: string, replace: (next?: string) => void) => void,
  acceptsRule: (rule: string) => boolean,
): void {
  const recorded = leaf.recordedAs ?? leaf.at
  const field = leaf.each
  if (field) {
    const list = detachAt(payload, leaf.at)
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (!isPlainObject(item)) continue
      const current = item[field]
      const rule = firstRuleInTexts(wholeFieldTexts(current), acceptsRule)
      if (!rule) continue
      onMatch(recorded, rule, (next) => {
        item[field] =
          typeof current === 'string'
            ? (next ?? redactOutboxText(current).text)
            : WITHHELD_SECRET_SHAPED
      })
    }
    return
  }
  const current = getAt(payload, leaf.at)
  const rule = firstRuleInTexts(wholeFieldTexts(current), acceptsRule)
  if (!rule) return
  onMatch(recorded, rule, (next) => {
    const nested = leaf.at.lastIndexOf('.')
    if (nested > 0) detachAt(payload, leaf.at.slice(0, nested))
    setAt(
      payload,
      leaf.at,
      typeof current === 'string'
        ? (next ?? redactOutboxText(current).text)
        : WITHHELD_SECRET_SHAPED,
    )
  })
}

function applyElementsLeaf(
  payload: Record<string, unknown>,
  leaf: SecretLeaf,
  onMatch: (path: string, rule: string, replace: (next?: string) => void) => void,
  acceptsRule: (rule: string) => boolean,
): void {
  const current = detachAt(payload, leaf.at)
  if (!Array.isArray(current)) return
  for (const [index, item] of current.entries()) {
    if (typeof item !== 'string') continue
    const rule = redactOutboxText(item).rules.find(acceptsRule)
    if (!rule) continue
    onMatch(`${leaf.at}[${index}]`, rule, (next) => {
      current[index] = next ?? redactOutboxText(item).text
    })
  }
}

function applyWalkLeaf(
  payload: Record<string, unknown>,
  leaf: SecretLeaf,
  onMatch: (path: string, rule: string, replace: (next?: string) => void) => void,
  acceptsRule: (rule: string) => boolean,
): void {
  walkStrings(detachAt(payload, leaf.at), leaf.at, (path, text, replace) => {
    const rule = redactOutboxText(text).rules.find(acceptsRule)
    if (rule) onMatch(path, rule, (next) => replace(next ?? redactOutboxText(text).text))
  })
}

function applyLeaf(
  payload: Record<string, unknown>,
  leaf: SecretLeaf,
  onMatch: (path: string, rule: string, replace: (next?: string) => void) => void,
  acceptsRule: (rule: string) => boolean = () => true,
): void {
  if (leaf.style === 'value') applyValueLeaf(payload, leaf, onMatch, acceptsRule)
  else if (leaf.style === 'elements') applyElementsLeaf(payload, leaf, onMatch, acceptsRule)
  else applyWalkLeaf(payload, leaf, onMatch, acceptsRule)
}

export type OutboxSanitizeMatch = { path: string; rule: string }

export function sanitizeOutboxPayloadForRules(
  kind: string,
  payload: Record<string, unknown>,
  rules: ReadonlySet<string>,
): { payload: Record<string, unknown>; matches: OutboxSanitizeMatch[] } {
  const next = clonePayload(payload)
  if (!(kind in LEAVES)) return { payload: next, matches: [] }
  const matches: OutboxSanitizeMatch[] = []
  for (const leaf of LEAVES[kind as OutboxSanitizeKind]) {
    applyLeaf(
      next,
      leaf,
      (path, rule, replace) => {
        replace()
        matches.push({ path, rule })
      },
      (rule) => rules.has(rule),
    )
  }
  const existing = Array.isArray(next.withheldFields)
    ? next.withheldFields.filter((path): path is string => typeof path === 'string')
    : []
  next.withheldFields = [...new Set([...existing, ...matches.map((match) => match.path)])]
  return { payload: next, matches }
}

export function sanitizeOutboxPayload(
  kind: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next = replaceUnstorableCodePoints(payload) as Record<string, unknown>
  if (!(kind in LEAVES) || Array.isArray(next.withheldFields)) return next
  const withheld: string[] = []
  for (const leaf of LEAVES[kind as OutboxSanitizeKind]) {
    applyLeaf(next, leaf, (path, _rule, replace) => {
      replace()
      withheld.push(path)
    })
  }
  next.withheldFields = [...new Set(withheld)]
  return next
}

export function stringifyOutboxPayload(kind: string, payload: Record<string, unknown>): string {
  return serializeOutboxPayload(kind, sanitizeOutboxPayload(kind, payload))
}

export function firstOutboxEvidenceRule(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  if (!(kind in LEAVES)) return null
  const copy = clonePayload(payload)
  for (const leaf of LEAVES[kind as OutboxSanitizeKind]) {
    let found: string | null = null
    applyLeaf(copy, leaf, (_path, rule) => {
      found ??= rule
    })
    if (found) return found
  }
  return null
}
