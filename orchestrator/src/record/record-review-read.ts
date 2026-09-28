// concern: record-review-read
/** Maps a local architect read payload to hosted record values. */

type Payload = Record<string, unknown>
type CommonValues = {
  id: string
  spaceId: string
  machineId: string
  localId: bigint
  createdAt: Date
  updatedAt: Date
}

export function reviewReadRecordValues(
  row: Payload,
  projectId: string | null,
  common: CommonValues,
) {
  return {
    ...common,
    projectId,
    branch: String(row.branch),
    tip: String(row.tip),
    patchId: String(row.patchId),
    pathSet: JSON.stringify(row.pathSet),
    tier: Number(row.tier),
    note: String(row.note),
    sessionId: row.sessionId == null ? null : String(row.sessionId),
    recordedAt: new Date(String(row.recordedAt)),
  }
}
