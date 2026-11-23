// concern: record-space-agents
/** Owns tenant-bound hosted space-agent declaration reads and mutations. */
import type { SQL } from 'bun'
import { maskHostedTableWrite } from '../../../shared/hosted-secret-mask.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { recordPool } from './record-pool.ts'

type Tenant = { url: string } & TenantPrincipal
export type RecordSpaceAgent = {
  name: string
  harness: string
  backend: string
  model: string
  baseUrl: string | null
  transport: string
  provider: string | null
  apiKeySecret: string | null
  requestSettings: unknown | null
  jobs: unknown | null
  preferredJobs: unknown | null
  maxConcurrent: number | null
  routeMetered: boolean
  trainsOnInputs: boolean
  operatedBy: string
  billing: string
}

async function tenant<T>(input: Tenant, use: (tx: SQL) => Promise<T>): Promise<T> {
  return recordPool(input.url).begin(async (tx) => {
    await bindTenant(tx, input)
    return use(tx)
  })
}

function output(row: Record<string, unknown>): RecordSpaceAgent {
  return {
    name: String(row.name),
    harness: String(row.harness),
    backend: String(row.backend),
    model: String(row.model),
    baseUrl: row.base_url === null ? null : String(row.base_url),
    transport: String(row.transport),
    provider: row.provider === null ? null : String(row.provider),
    apiKeySecret: row.api_key_secret === null ? null : String(row.api_key_secret),
    requestSettings: row.request_settings,
    jobs: row.jobs,
    preferredJobs: row.preferred_jobs,
    maxConcurrent: row.max_concurrent === null ? null : Number(row.max_concurrent),
    routeMetered: Boolean(row.route_metered),
    trainsOnInputs: Boolean(row.trains_on_inputs),
    operatedBy: String(row.operated_by),
    billing: String(row.billing),
  }
}

export async function readRecordSpaceAgents(input: Tenant): Promise<RecordSpaceAgent[]> {
  return tenant(input, async (tx) => {
    const rows = (await tx`
      SELECT * FROM space_agent WHERE space_id=${input.spaceId}::uuid ORDER BY name
    `) as Record<string, unknown>[]
    return rows.map(output)
  })
}

export async function upsertRecordSpaceAgent(
  original: Tenant & RecordSpaceAgent,
): Promise<RecordSpaceAgent> {
  const input = maskHostedTableWrite('space_agent', original)
  return tenant(input, async (tx) => {
    const rows = (await tx`
      INSERT INTO space_agent(
        id,space_id,name,harness,backend,model,base_url,transport,provider,api_key_secret,
        request_settings,jobs,preferred_jobs,max_concurrent,route_metered,trains_on_inputs,
        operated_by,billing
      ) VALUES (
        ${newRecordId()}::uuid,${input.spaceId}::uuid,${input.name},${input.harness},
        ${input.backend},${input.model},${input.baseUrl},${input.transport},${input.provider},
        ${input.apiKeySecret},${input.requestSettings},${input.jobs},${input.preferredJobs},
        ${input.maxConcurrent},${input.routeMetered},${input.trainsOnInputs},${input.operatedBy},
        ${input.billing}
      ) ON CONFLICT (space_id,name) DO UPDATE SET
        harness=excluded.harness,backend=excluded.backend,model=excluded.model,
        base_url=excluded.base_url,transport=excluded.transport,provider=excluded.provider,
        api_key_secret=excluded.api_key_secret,request_settings=excluded.request_settings,
        jobs=excluded.jobs,preferred_jobs=excluded.preferred_jobs,
        max_concurrent=excluded.max_concurrent,route_metered=excluded.route_metered,
        trains_on_inputs=excluded.trains_on_inputs,operated_by=excluded.operated_by,
        billing=excluded.billing
      RETURNING *
    `) as Record<string, unknown>[]
    return output(rows[0]!)
  })
}

export async function deleteRecordSpaceAgent(
  input: Tenant & { name: string },
): Promise<{ removed: boolean }> {
  return tenant(input, async (tx) => {
    const rows = (await tx`
      DELETE FROM space_agent WHERE space_id=${input.spaceId}::uuid AND name=${input.name}
      RETURNING id
    `) as Record<string, unknown>[]
    return { removed: rows.length === 1 }
  })
}
