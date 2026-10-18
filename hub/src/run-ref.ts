import { hasRecordIdShape } from '../../shared/record-id.ts'

export function runRef(ref: string): { root: string; turn: string | null } | null {
  const match = ref.match(/^orch:([^:]+)(?::turn:([^:]+))?$/)
  if (!match) return null
  const root = match[1]!.toLowerCase()
  const turn = match[2]?.toLowerCase() ?? null
  if (!hasRecordIdShape(root) || (turn !== null && !hasRecordIdShape(turn))) return null
  return { root, turn }
}
