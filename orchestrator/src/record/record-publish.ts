// concern: record-publish
/** Builds local orchestrator views and publishes each independently to the hosted record. */
import { agentsPayload } from '../agent/agent-commands.ts'
import { blockersPayload, healthPayload } from '../health/health-commands.ts'
import { jobsPayload } from '../jobs/job-commands.ts'
import { state } from '../state/serve.ts'
import { machineId } from './machine-identity.ts'
import { type RecordApiClient, recordApiClient } from './record-api-client.ts'
import { SNAPSHOT_KINDS, type SnapshotKind } from './record-snapshots.ts'

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
  availability: { hostedConfigured: boolean; signedIn: boolean }
}

export type RecordPublishDecision = { publish: true } | { publish: false; reason: string }

/** Decide whether a scheduled snapshot publish has a hosted destination and an identity. */
export function decideRecordPublish(input: {
  hostedConfigured: boolean
  signedIn: boolean
}): RecordPublishDecision {
  if (!input.hostedConfigured) {
    return { publish: false, reason: 'no hosted record is configured for this install' }
  }
  if (!input.signedIn) {
    return { publish: false, reason: 'no one is signed in to the hosted record' }
  }
  return { publish: true }
}

export async function publishSnapshotsCommand(
  presentation: Presentation,
  deps: PublishDeps,
): Promise<void> {
  const decision = decideRecordPublish(deps.availability)
  if (!decision.publish) {
    presentation.log(`nothing published — ${decision.reason}`)
    return
  }
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
