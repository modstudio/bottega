import type { ManifestColumn } from './identity-inventory.ts'

const reason =
  'reader identity: a harness session id, the operator, or a run label whose run is named by reader_run_record_id'

const localReaderSessions: readonly ManifestColumn[] = [
  'board_hosted_adoption_receipt.reader_session',
  'board_receipt.reader_session',
  'hosted_board_receipt_cache.reader_session',
].map((column) => ({ store: 'orchestrator', column, reason }))

export const BOARD_READER_EXTERNAL_IDENTIFIERS: readonly ManifestColumn[] = [
  ...localReaderSessions,
  { store: 'hosted', column: 'board_receipt.reader_session', reason },
]
