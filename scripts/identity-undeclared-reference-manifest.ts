import type { ManifestColumn } from './identity-inventory.ts'

const manifest = (store: ManifestColumn['store'], columns: readonly string[]): ManifestColumn[] =>
  columns.map((column) => ({
    store,
    column,
    reason: 'natural or encoded reference to an application row',
  }))

export const UNDECLARED_REFERENCES: readonly ManifestColumn[] = [
  ...manifest('orchestrator', [
    'operator_notification.item_id',
    'run.launch_key',
    'workflow_cursor.instance_id',
  ]),
]
