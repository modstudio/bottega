// concern: record-publish
/** Builds local orchestrator views and publishes each independently to the hosted record. */
import { agentsPayload } from './agent-commands.ts'
import { blockersPayload, healthPayload } from './health-commands.ts'
import { jobsPayload } from './job-commands.ts'
import { machineId } from './machine-identity.ts'
import { type RecordApiClient, recordApiClient } from './record-api-client.ts'
import { SNAPSHOT_KINDS, type SnapshotKind } from './record-snapshots.ts'
import { state } from './serve.ts'

export async function buildSnapshotPayload(kind: SnapshotKind): Promise<unknown> {
  switch (kind) {
    case 'state':
      return state()
    case 'blockers':
      return blockersPayload()
    case 'health':
      return healthPayload()
    case 'jobs':
      return jobsPayload()
    case 'agents':
      return agentsPayload()
  }
}

type Presentation = { log(value: string): void; setExitCode(code: number): void }
type PublishDeps = {
  client?: RecordApiClient
  identity?: string
  build?: (kind: SnapshotKind) => Promise<unknown>
}

export async function publishSnapshotsCommand(
  presentation: Presentation,
  deps: PublishDeps = {},
): Promise<void> {
  const client = deps.client ?? recordApiClient()
  const identity = deps.identity ?? machineId()
  const build = deps.build ?? buildSnapshotPayload
  let failed = false
  for (const kind of SNAPSHOT_KINDS) {
    let bytes = 0
    try {
      const payload = await build(kind)
      bytes = Buffer.byteLength(JSON.stringify(payload))
      await client.putSnapshot(kind, { machineId: identity, payload })
      presentation.log(`${kind}\t${bytes}\tpublished`)
    } catch (error) {
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      presentation.log(`${kind}\t${bytes}\tfailed: ${message}`)
    }
  }
  if (failed) presentation.setExitCode(1)
}
