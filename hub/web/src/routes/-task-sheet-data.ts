import type { UseTaskResult } from '@bottega/hub-data/use-task'

export type TaskSheetDetail = NonNullable<UseTaskResult['detail']>
export type TaskSheetResult = UseTaskResult

/** A task route's search: which stored task a key names, and which of its documents is open. */
export function taskSearch(search: Record<string, unknown>): { id?: string; doc?: string } {
  return {
    id: typeof search.id === 'string' ? search.id : undefined,
    doc: typeof search.doc === 'string' ? search.doc : undefined,
  }
}
