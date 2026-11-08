import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import { assertLocalRevisionWrite } from './doc-revision-store.ts'

export function assertDocWriteRevisionForAuthority(
  input: { scope: string; subject: string | null; slug: string; expectedRevision?: string },
  current: string | null,
  isCreate: boolean,
): void {
  if (
    currentRecordWriteDecision().verdict === 'hosted' &&
    isCreate &&
    input.expectedRevision !== undefined
  ) {
    return
  }
  assertLocalRevisionWrite(input, current, isCreate)
}

export function hostedDocWriteOperation(
  requested: 'import' | undefined,
  prior: unknown | null,
  expectedRevision: string | undefined,
): 'create' | 'set' | 'import' {
  return requested ?? (prior === null && expectedRevision === undefined ? 'create' : 'set')
}
