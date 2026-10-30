// concern: record-api-machine
/** Owns hosted machine name and retirement routes. */
import type { Hono } from 'hono'
import { z } from 'zod'
import type { RecordIdentity } from './record-auth.ts'

type Environment = { Variables: { identity: RecordIdentity; destinationSpaceId?: string } }
export type RecordMachineRouteDeps = {
  recordUrl: string
  renameMachine?(input: {
    url: string
    identity: RecordIdentity
    machineId: string
    shortName?: string
    displayName?: string
  }): Promise<void>
  retireMachine?(input: {
    url: string
    identity: RecordIdentity
    shortName: string
  }): Promise<string>
}

export function registerRecordMachineRoutes(
  app: Hono<Environment>,
  deps: RecordMachineRouteDeps,
): void {
  app.put('/v1/machine/name', async (context) => {
    if (!deps.renameMachine) return context.json({ error: 'machine rename is not available' }, 501)
    const body = z
      .object({
        machineId: z.string().uuid(),
        shortName: z.string().optional(),
        displayName: z.string().optional(),
      })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid machine rename' }, 400)
    try {
      await deps.renameMachine({
        url: deps.recordUrl,
        identity: context.get('identity'),
        ...body.data,
      })
      return context.json({ ok: true as const })
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  })
  app.post('/v1/machine/retire', async (context) => {
    if (!deps.retireMachine) return context.json({ error: 'machine retire is not available' }, 501)
    const body = z
      .object({ shortName: z.string().min(1) })
      .safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json({ error: 'invalid machine retirement' }, 400)
    try {
      const machineId = await deps.retireMachine({
        url: deps.recordUrl,
        identity: context.get('identity'),
        shortName: body.data.shortName,
      })
      return context.json({ machineId })
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  })
}
