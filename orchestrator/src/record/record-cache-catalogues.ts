// concern: record-cache-catalogues
/** Pulls every hosted catalogue stream required before a project may use a space. */

import type { Database } from 'bun:sqlite'
import { pullLensCatalogue } from './record-cache-lens.ts'
import { pullPortCatalogue } from './record-cache-port.ts'
import { pullWorkflowCatalogue } from './record-cache-workflow.ts'

export type RecordCatalogueStream = 'lens' | 'workflow' | 'port'

export class RecordCataloguePullError extends Error {
  readonly stream: RecordCatalogueStream

  constructor(stream: RecordCatalogueStream, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.stream = stream
  }
}

export async function pullRecordCataloguesForSpace(
  local: Database,
  spaceId: string,
): Promise<void> {
  try {
    await pullLensCatalogue(local, [spaceId])
  } catch (error) {
    throw new RecordCataloguePullError('lens', error)
  }
  try {
    const pulled = await pullWorkflowCatalogue(local, [spaceId])
    if (!pulled.completedSpaces.has(spaceId))
      throw new Error('the hosted stream refers to catalogue parents that are not cached')
  } catch (error) {
    throw new RecordCataloguePullError('workflow', error)
  }
  try {
    const pulled = await pullPortCatalogue(local, [spaceId])
    if (!pulled.completedSpaces.has(spaceId))
      throw new Error('the hosted stream refers to catalogue parents that are not cached')
  } catch (error) {
    throw new RecordCataloguePullError('port', error)
  }
}
