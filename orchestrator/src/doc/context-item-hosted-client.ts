// concern: context-item-hosted-client
/** Binds hosted context-item writes to the holder's record destination. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordWriteOwner } from '../../../shared/record-write-space.ts'
import { projectAt } from '../project/projects.ts'
import { RecordApiRequestError, recordApiClient } from '../record/record-api-client.ts'
import { recordWriteDestination } from '../record/record-write-destination.ts'
import { resolveContextTaskByRecordId } from './context-write-adapter.ts'

async function contextItemOwner(holder: string): Promise<RecordWriteOwner | null> {
  if (holder.startsWith('session:')) {
    return { kind: 'session', checkoutProject: projectAt(process.cwd())?.name ?? null }
  }
  if (holder.startsWith('task:')) {
    const { task, unreadable } = await resolveContextTaskByRecordId(holder.slice('task:'.length))
    if (task) return { kind: 'task', projectName: task.project }
    throw new RecordApiRequestError(
      unreadable.length > 0
        ? `task context owner could not be resolved because the tasks of ${unreadable.join(', ')} could not be read; run \`${PLATFORM_SLUG} record doctor\`, then retry`
        : `task context owner could not be resolved; retry with \`${PLATFORM_SLUG} agent context set --task <KEY>\``,
      'refused',
      409,
    )
  }
  return null
}

export async function hostedContextItemClient(holder: string, suppliedOwner?: RecordWriteOwner) {
  const client = recordApiClient()
  const owner = suppliedOwner ?? (await contextItemOwner(holder))
  const destination = await recordWriteDestination(client, owner)
  return {
    upsert: (input: Parameters<typeof client.upsertContextItem>[0]) =>
      client.upsertContextItem(input, destination),
    remove: (id: string, input: { expectedRevision?: string }) =>
      client.deleteContextItem(id, input, destination),
  }
}
