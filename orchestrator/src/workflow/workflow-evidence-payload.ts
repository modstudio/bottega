// concern: workflows
/** The declared evidence payload one workflow exec hands to the process that records its row. */

/**
 * The receiver builds its own row from these values through `recordWorkflowCommand`,
 * so its redaction and tail bounding are the code that matches the store. The heads
 * travel with the output because redaction removes them from the lines it keeps.
 */
export type WorkflowEvidencePayload = {
  command: string[]
  cwd: string
  exitCode: number
  signal: string | null
  output: string
  /** The checkout head after the command, and the head it ran against. */
  headCommit: string | null
  preCommandHeadCommit: string | null
}

export function encodeWorkflowEvidencePayload(payload: WorkflowEvidencePayload): string {
  return JSON.stringify(payload)
}

const PAYLOAD_REFUSAL_PREFIX = 'refusing a workflow exec evidence payload: '
const PAYLOAD_REFUSAL_REMEDY = '; build the payload with encodeWorkflowEvidencePayload'

function payloadRefusal(field: string, expected: string): Error {
  return new Error(`${PAYLOAD_REFUSAL_PREFIX}${field} must be ${expected}${PAYLOAD_REFUSAL_REMEDY}`)
}

/**
 * Validates one payload where it enters the receiving form. Every refusal names a field
 * and a reason and nothing else: no redaction has run on the payload, so its text — and
 * the child output it carries — must never reach a message, a log or stderr.
 */
export function parseWorkflowEvidencePayload(text: string): WorkflowEvidencePayload {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // A parse error's own message quotes the offending input, which is unredacted payload text.
    throw new Error(`${PAYLOAD_REFUSAL_PREFIX}it is not JSON${PAYLOAD_REFUSAL_REMEDY}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw payloadRefusal('the payload', 'an object')
  const row = value as Record<string, unknown>
  if (
    !Array.isArray(row.command) ||
    row.command.length === 0 ||
    row.command.some((token) => typeof token !== 'string')
  )
    throw payloadRefusal('command', 'a non-empty array of strings')
  if (typeof row.cwd !== 'string' || !row.cwd) throw payloadRefusal('cwd', 'a non-empty string')
  if (!Number.isInteger(row.exitCode)) throw payloadRefusal('exitCode', 'an integer')
  if (!(row.signal === null || typeof row.signal === 'string'))
    throw payloadRefusal('signal', 'a string or null')
  if (typeof row.output !== 'string') throw payloadRefusal('output', 'a string')
  if (!(row.headCommit === null || typeof row.headCommit === 'string'))
    throw payloadRefusal('headCommit', 'a string or null')
  if (!(row.preCommandHeadCommit === null || typeof row.preCommandHeadCommit === 'string'))
    throw payloadRefusal('preCommandHeadCommit', 'a string or null')
  return {
    command: row.command as string[],
    cwd: row.cwd,
    exitCode: row.exitCode as number,
    signal: row.signal as string | null,
    output: row.output,
    headCommit: row.headCommit as string | null,
    preCommandHeadCommit: row.preCommandHeadCommit as string | null,
  }
}
