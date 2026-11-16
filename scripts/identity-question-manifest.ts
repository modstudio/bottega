import type { ManifestColumn } from './identity-inventory.ts'

const uuid = (column: string): ManifestColumn => ({
  store: 'orchestrator',
  column,
  reason: 'owned or referenced UUID',
})

export const QUESTION_UUID_COLUMNS = [
  'question.record_id',
  'question.run_record_id',
  'question.filed_record_id',
  'question_delivery.record_id',
  'question_delivery.question_record_id',
  'question_delivery.run_record_id',
  'question_delivery_pending.question_record_id',
  'question_delivery_pending.run_record_id',
  'question_mutation_audit.record_id',
  'question_mutation_audit.question_record_id',
].map(uuid)
