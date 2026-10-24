// concern: contract
/**
 * The pure reply-parsing slice: the JSON-schema validator, the reply schemas
 * that stand alone, and the brace-scanner that recovers a structured reply from
 * whatever an agent actually returned.
 *
 * This lives apart from contract.ts because contract.ts reaches
 * run/checkpoint.ts and therefore the database, while the spare-hands lane
 * parses replies and must stay pure: no database, process or clock. Nothing
 * here may reach any of those, so this module imports nothing at all.
 */

/**
 * Recover the worker's structured reply from whatever actually came back.
 *
 * Three fallbacks, in descending order of how well-behaved the agent was,
 * because losing a finished implementation to a formatting slip would be an
 * absurd way to fail:
 *
 *   1. the whole reply is the object (a schema-constrained agent)
 *   2. it is inside a fenced block (a model that explained itself first)
 *   3. it is the outermost braces anywhere in the text
 *
 * Returns null when nothing parses, and the caller treats THAT as its own kind
 * of failure rather than as `done`. Assuming success from an unreadable reply
 * is how a run that never touched the code gets recorded as a completed one.
 */
export type JsonSchema = {
  type?: string | readonly string[]
  properties?: { readonly [key: string]: JsonSchema }
  required?: readonly string[]
  items?: JsonSchema
  enum?: readonly unknown[]
  anyOf?: readonly JsonSchema[]
  additionalProperties?: boolean
}

/** Whether one type name matches the value it is tested against. */
function matchesType(value: unknown, type: string): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }
  return typeof value === type
}

/**
 * Validate an object's required keys and every declared property it carries.
 *
 * additionalProperties:false is NOT enforced here. The schema declares it so a
 * schema-bound agent cannot invent fields, but a worker that did the work and
 * added one stray key has not stopped doing the work, and rejecting the reply
 * would throw a finished implementation away over a field nobody reads.
 */
function validatesObject(object: Record<string, unknown>, schema: JsonSchema): boolean {
  if (schema.required?.some((key) => !Object.hasOwn(object, key))) return false
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(object, key) && !validatesSchema(object[key], child)) return false
    }
  }
  return true
}

export function validatesSchema(value: unknown, schema: JsonSchema): boolean {
  if (schema.anyOf && !schema.anyOf.some((choice) => validatesSchema(value, choice))) return false
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) return false

  const types = typeof schema.type === 'string' ? [schema.type] : schema.type
  if (types && !types.some((type) => matchesType(value, type))) return false

  if (Array.isArray(value) && schema.items) {
    return value.every((item) => validatesSchema(item, schema.items!))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return validatesObject(value as Record<string, unknown>, schema)
  }
  return true
}

/**
 * Which authoritative canon source was available to a run.
 *
 * Shared by the review and verify-claim contracts so a reader never has to
 * translate two provenance dialects. `unknown` is deliberately distinct from
 * either source: some clients expose no diagnostic and orchestrator must not
 * invent one for them.
 */
export const CANON_SOURCE_SCHEMA = {
  type: 'string',
  enum: ['live database', 'mirror', 'unknown'],
} as const

/** verify-claim keeps its verdict contract; only its provenance is added. */
export const VERIFY_CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'provenance'],
  properties: {
    verdict: { type: 'string', enum: ['true', 'false', 'undecidable'] },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['canon_source'],
      properties: { canon_source: CANON_SOURCE_SCHEMA },
    },
  },
} as const

/**
 * The JSON objects in a reply, in the order they must be offered: NEWEST
 * first.
 *
 * A worker under a schema narrates in the same shape it was told to reply in:
 * one run opened with `{"status":"done","summary":"Starting by reading the
 * canon...","files_changed":[]}` and emitted its real reply afterwards. Taking
 * the span from the first `{` to the last `}` covers both and parses as
 * neither, so a completed change set — three files, 150 lines — was recorded
 * as "reply did not match the worker contract".
 *
 * Worse than losing it would be BELIEVING the first: it says `done` with no
 * files, which is a confident report of having finished nothing.
 *
 * So the objects are scanned out by brace depth, honoring strings and escapes,
 * and offered newest first. Depth-scanned rather than regexed because a JSON
 * object nests, and a brace inside a summary string is not a brace.
 */
function scanJsonObjects(text: string): string[] {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      ;({ inString, escaped } = advanceStringState(inString, escaped, ch))
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch !== '}') continue
    depth--
    if (depth === 0 && start !== -1) {
      objects.push(text.slice(start, i + 1))
      start = -1
    }
  }
  objects.reverse()
  return objects
}

/** Whether a character inside a string ends it, opens an escape, or does neither. */
function advanceStringState(inString: boolean, escaped: boolean, ch: string) {
  if (escaped) return { inString: true, escaped: false }
  if (ch === '\\') return { inString: true, escaped: true }
  if (ch === '"') return { inString: false, escaped: false }
  return { inString, escaped }
}

/**
 * Parse one candidate object against the schema, or null when it does not carry
 * the contract.
 *
 * `blocked` is still accepted, and normalized. The word was renamed to `asking`
 * because a "blocker" here means the opposite — an environment problem rather
 * than a worker behaving correctly — but an agent whose schema was dropped, or
 * which is echoing older instructions, will still say `blocked`. Rejecting the
 * reply over a synonym would throw away a completed implementation.
 *
 * A malformed candidate is dropped rather than rejecting the whole reply: a
 * worker that did the work and garbled one question should not lose the work.
 * Schema validation supersedes any looser recovery policy here.
 */
function parseCandidate<T>(candidate: string, schema: JsonSchema): T | null {
  try {
    let o = JSON.parse(candidate)
    if (o && typeof o === 'object' && !Array.isArray(o) && o.status === 'blocked') {
      o = { ...o, status: 'asking' }
    }
    return validatesSchema(o, schema) ? o : null
  } catch {
    return null
  }
}

/**
 * Parse a reply against one declared schema, for the caller to name as the
 * reply type it expects.
 *
 * The schema is required rather than defaulted to the worker contract: a
 * default to a schema another module owns hides which contract a caller is
 * reading, and this parser now serves more than the worker reply.
 */
export function parseWorkerReplyWithCount<T>(
  text: string,
  schema: JsonSchema,
): { reply: T | null; contractObjects: number } {
  const valid = scanJsonObjects(text.trim())
    .map((candidate) => parseCandidate<T>(candidate, schema))
    .filter((value): value is T => value !== null)
  return { reply: valid[0] ?? null, contractObjects: valid.length }
}
