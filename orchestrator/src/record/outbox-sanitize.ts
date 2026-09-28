// concern: outbox-sanitize
/** Withholds secret-shaped free-text leaves from hosted outbox payloads. Must not know Postgres. */
import { evidenceSecretShapedRule } from '../../../shared/secret-shaped.ts'

export const WITHHELD_SECRET_SHAPED = '[withheld: secret-shaped content]'

export type OutboxSanitizeKind =
  | 'run'
  | 'score'
  | 'question'
  | 'review'
  | 'review_lens'
  | 'review_finding'
  | 'review_read'
  | 'landing'
  | 'landing_override'
  | 'contention'
  | 'test_flake'

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
    { at: 'options', style: 'value' },
    { at: 'recommendation', style: 'value' },
    { at: 'why', style: 'value' },
    { at: 'answer', style: 'value' },
    { at: 'overturnReason', style: 'value', recordedAs: 'overturn_reason' },
    { at: 'replacement', style: 'value' },
    { at: 'filedRef', style: 'value', recordedAs: 'filed_ref' },
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
  landing: [
    { at: 'error', style: 'value' },
    { at: 'steps', style: 'walk' },
  ],
  landing_override: [{ at: 'reason', style: 'value' }],
  contention: [{ at: 'cause', style: 'value' }],
  test_flake: [
    { at: 'test', style: 'value' },
    { at: 'file', style: 'value' },
    { at: 'signal', style: 'value' },
  ],
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clonePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
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

function firstRuleInTexts(texts: string[]): string | null {
  for (const text of texts) {
    const rule = evidenceSecretShapedRule(text)
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

function applyValueLeaf(
  payload: Record<string, unknown>,
  leaf: SecretLeaf,
  onMatch: (path: string, rule: string, replace: () => void) => void,
): void {
  const recorded = leaf.recordedAs ?? leaf.at
  if (leaf.each) {
    const list = getAt(payload, leaf.at)
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (!isPlainObject(item)) continue
      const current = item[leaf.each]
      const rule = firstRuleInTexts(wholeFieldTexts(current))
      if (!rule) continue
      onMatch(recorded, rule, () => {
        item[leaf.each] = WITHHELD_SECRET_SHAPED
      })
    }
    return
  }
  const current = getAt(payload, leaf.at)
  const rule = firstRuleInTexts(wholeFieldTexts(current))
  if (!rule) return
  onMatch(recorded, rule, () => setAt(payload, leaf.at, WITHHELD_SECRET_SHAPED))
}

function applyElementsLeaf(
  payload: Record<string, unknown>,
  leaf: SecretLeaf,
  onMatch: (path: string, rule: string, replace: () => void) => void,
): void {
  const current = getAt(payload, leaf.at)
  if (!Array.isArray(current)) return
  for (const [index, item] of current.entries()) {
    if (typeof item !== 'string') continue
    const rule = evidenceSecretShapedRule(item)
    if (!rule) continue
    onMatch(`${leaf.at}[${index}]`, rule, () => {
      current[index] = WITHHELD_SECRET_SHAPED
    })
  }
}

function applyWalkLeaf(
  payload: Record<string, unknown>,
  leaf: SecretLeaf,
  onMatch: (path: string, rule: string, replace: () => void) => void,
): void {
  walkStrings(getAt(payload, leaf.at), leaf.at, (path, text, replace) => {
    const rule = evidenceSecretShapedRule(text)
    if (rule) onMatch(path, rule, () => replace(WITHHELD_SECRET_SHAPED))
  })
}

function applyLeaf(
  payload: Record<string, unknown>,
  leaf: SecretLeaf,
  onMatch: (path: string, rule: string, replace: () => void) => void,
): void {
  if (leaf.style === 'value') applyValueLeaf(payload, leaf, onMatch)
  else if (leaf.style === 'elements') applyElementsLeaf(payload, leaf, onMatch)
  else applyWalkLeaf(payload, leaf, onMatch)
}

export function sanitizeOutboxPayload(
  kind: OutboxSanitizeKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next = clonePayload(payload)
  const withheld: string[] = []
  for (const leaf of LEAVES[kind]) {
    applyLeaf(next, leaf, (path, _rule, replace) => {
      replace()
      withheld.push(path)
    })
  }
  next.withheldFields = [...new Set(withheld)]
  return next
}

export function stringifyOutboxPayload(
  kind: OutboxSanitizeKind,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify(sanitizeOutboxPayload(kind, payload))
}

export function firstOutboxEvidenceRule(
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  if (!(kind in LEAVES)) return null
  for (const leaf of LEAVES[kind as OutboxSanitizeKind]) {
    let found: string | null = null
    applyLeaf(payload, leaf, (_path, rule) => {
      found ??= rule
    })
    if (found) return found
  }
  return null
}
