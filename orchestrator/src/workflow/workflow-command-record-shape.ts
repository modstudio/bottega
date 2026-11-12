// concern: workflows
/** Reads and validates a context-bearing workflow flag at the command edge. */
import { assertRecordShape, type ContextRecordName } from '../../../shared/record-shape.ts'
import { flagValue } from '../cli/args.ts'

export function workflowCommandRecordShape(
  argv: string[],
  flag: string,
  record: ContextRecordName,
): string | undefined {
  const text = flagValue(argv, flag)
  if (text !== undefined) assertRecordShape(record, text)
  return text
}

export function workflowNextCommandRecordShapes(argv: string[]) {
  return {
    selfRuling: workflowCommandRecordShape(argv, 'self-ruling', 'self-ruling'),
    basis: workflowCommandRecordShape(argv, 'basis', 'basis'),
    note: workflowCommandRecordShape(argv, 'note', 'step note'),
    question: workflowCommandRecordShape(argv, 'question', 'open question'),
  }
}
