// concern: workflow floor evidence
/** Resolves a user-facing probe number or UUID once, at the edge. */

import { storedMachineNames } from '../../../shared/machine-config.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { decideMachineLabel, type MachineIdentifierNames } from '../run/run-identifier-grammar.ts'

type ProbeDatabase = {
  query(sql: string): unknown
}

type ProbeRecordIdQuery = { get(identifier: string | number): { record_id: string } | null }

type ParsedProbeIdentifier =
  | { kind: 'number'; number: number }
  | { kind: 'record-id'; recordId: string }

export type ParsedProbeArtifact = {
  kind: 'probe' | 'exec'
  identifier: ParsedProbeIdentifier
}

const ACCEPTED_PROBE_IDENTIFIERS =
  'a positive decimal probe number, name/number, or a full probe UUID'

const machineNames = (): MachineIdentifierNames | null => {
  const stored = storedMachineNames()
  return stored
    ? { shortName: stored.shortName, formerShortNames: stored.formerShortNames ?? [] }
    : null
}

function parseProbeIdentifier(
  input: string | number,
  names: MachineIdentifierNames | null = machineNames(),
): ParsedProbeIdentifier {
  const original = String(input)
  const label = decideMachineLabel(original, names)
  if (label.kind === 'refused') throw new Error(label.reason)
  const given = label.kind === 'bare' ? label.remainder : original
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'number', number }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  throw new Error(
    `invalid probe identifier ${JSON.stringify(given)}: expected ${ACCEPTED_PROBE_IDENTIFIERS}`,
  )
}

export function parseProbeArtifact(
  artifact: string,
  names: MachineIdentifierNames | null = machineNames(),
): ParsedProbeArtifact | undefined {
  const parsed = /^(probe|exec):(.+)$/i.exec(artifact.trim())
  if (!parsed) return undefined
  return {
    kind: parsed[1]!.toLowerCase() as ParsedProbeArtifact['kind'],
    identifier: parseProbeIdentifier(parsed[2]!, names),
  }
}

export function resolveProbeIdentifier(
  database: ProbeDatabase,
  input: string | number,
  names: MachineIdentifierNames | null = machineNames(),
): string {
  const parsed = parseProbeIdentifier(input, names)
  if (parsed.kind === 'number') {
    const query = database.query('SELECT record_id FROM probe WHERE number=?') as ProbeRecordIdQuery
    const row = query.get(parsed.number)
    if (row) return row.record_id
    throw new Error(`no probe has number ${parsed.number}; pass ${ACCEPTED_PROBE_IDENTIFIERS}`)
  }
  const query = database.query(
    'SELECT record_id FROM probe WHERE record_id=?',
  ) as ProbeRecordIdQuery
  const row = query.get(parsed.recordId)
  if (row) return row.record_id
  throw new Error(
    `no probe has UUID ${JSON.stringify(String(input))}; pass ${ACCEPTED_PROBE_IDENTIFIERS}`,
  )
}

export function resolveProbeArtifact(
  database: ProbeDatabase,
  artifact: string | undefined,
): string | undefined {
  if (artifact === undefined) return undefined
  const parsed = parseProbeArtifact(artifact)
  if (!parsed) return artifact
  const identifier =
    parsed.identifier.kind === 'number' ? parsed.identifier.number : parsed.identifier.recordId
  return `${parsed.kind}:${resolveProbeIdentifier(database, identifier)}`
}
