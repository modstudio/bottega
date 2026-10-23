// concern: one registration probe transport turn
/** Runs and records one probe turn. Must not know capability policy or CLI grammar. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { writableDb } from '../database/db.ts'
import { workerMcpLaunchSelection } from '../run/run-mcp-launch-scope.ts'
import { nextRunNumber } from '../run/run-number.ts'
import type {
  AgentTransport,
  NormalizedEvent,
  TransportHandle,
  TransportResult,
} from '../transport/transport.ts'
import { withTransportDeadline } from '../transport/transport.ts'
import type { WritingProbeConfinement } from './agent-writing-probe.ts'
import type { Agent } from './agents.ts'
import { resolveEndpointApiKeyEnv } from './endpoint-api-key.ts'

type ProbeTurnInput = {
  name: string
  scratch: string
  agent: Agent
  transport: AgentTransport
  id: string
  prompt: string
  schema?: string
  mcp?: boolean
  writing?: WritingProbeConfinement
  session?: string
}

type ProbeTurnResult = {
  status: TransportResult['status']
  output: string
  parsed: TransportResult['parsed']
  events: NormalizedEvent[]
  sessionId: string | null
  loadSessionAdvertised: boolean
}

const probeCwd = (input: ProbeTurnInput): string =>
  input.writing?.cwd ?? join(input.scratch, 'repo')
const probeScratchDir = (input: ProbeTurnInput): string =>
  input.writing?.scratchDir ?? input.scratch

function insertProbeTurn(input: ProbeTurnInput, started: number): string {
  const row = writableDb()
    .query(
      `INSERT INTO run (record_id,number,started_at,agent,job,cwd,prompt_sha,prompt_bytes,prompt_head,probe,status,model,transport)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id`,
    )
    .get(
      newRecordId(),
      nextRunNumber(writableDb()),
      new Date(started).toISOString(),
      input.name,
      `agent-probe-${input.id}`,
      probeCwd(input),
      createHash('sha256').update(input.prompt).digest('hex'),
      Buffer.byteLength(input.prompt),
      input.prompt.slice(0, 240),
      1,
      'running',
      input.agent.model ?? null,
      input.agent.defaultTransport,
    ) as { record_id: string }
  return row.record_id
}

async function probeEnvironment(agent: Agent, scratch: string): Promise<Record<string, string>> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...(agent.env?.() ?? {}),
    ...(await resolveEndpointApiKeyEnv(agent)),
    BOTTEGA_SCRATCH: scratch,
  }
}

async function drainTransportEvents(events: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _event of events) {
      /* consuming the stream lets transports finish their event lifecycle */
    }
  } catch {
    /* event observation never replaces the probe outcome */
  }
}

async function collectTurn(
  input: ProbeTurnInput,
  handle: TransportHandle,
  draining: Promise<void>,
): Promise<TransportResult> {
  const outcome = await withTransportDeadline({
    operation: (async () => {
      await input.transport.prompt(handle, input.prompt)
      return handle.collect()
    })(),
    operationName: `${input.agent.harness} agent probe prompt and collection; inspect harness logs and rerun ${PLATFORM_SLUG} agent probe ${input.name}`,
    timeoutMs: input.agent.timeoutMs,
    onTimeout: () => input.transport.cancel(handle),
  })
  await draining
  return outcome
}

/** Start through the selected transport, collect, and persist the turn outcome. */
export async function runProbeTurn(input: ProbeTurnInput): Promise<ProbeTurnResult> {
  const started = Date.now()
  const recordId = insertProbeTurn(input, started)
  const cwd = probeCwd(input)
  const scratchDir = probeScratchDir(input)
  const environment = await probeEnvironment(input.agent, scratchDir)
  if (input.writing) environment.HOME = input.writing.workerHomeDir
  try {
    const handle = await input.transport.start({
      agent: input.agent,
      cwd,
      prompt: input.prompt,
      outPath: join(input.scratch, `${input.id}.out`),
      schemaPath: input.schema,
      model: input.agent.model,
      modelExplicit: true,
      startedAt: started,
      write: true,
      sandbox: 'workspace-write',
      ...(input.writing ? {} : { writableRoots: [scratchDir] }),
      writingAcp: Boolean(input.writing),
      home: input.writing?.workerHomeDir,
      session: input.session,
      ...(input.writing
        ? {
            srt: {
              profile: input.writing.profile,
              runtimeDir: input.writing.runtimeDir,
            },
          }
        : {}),
      mcp: input.mcp ?? false,
      projectMcpSelection: input.mcp
        ? // The MCP probe turn attaches its minted stdio server directly, so it
          // asks through the one launch-selection decision, in the writing shape.
          workerMcpLaunchSelection({ usingMcp: true, writesJob: true, callerCwd: cwd, cwd })
        : null,
      env: environment,
    })
    const draining = drainTransportEvents(handle.events())
    try {
      const outcome = await collectTurn(input, handle, draining)
      writableDb()
        .query(
          `UPDATE run SET status=?,latency_ms=?,exit_code=?,output_bytes=?,error=? WHERE record_id=?`,
        )
        .run(
          outcome.status === 'ok' ? 'ok' : 'failed',
          Date.now() - started,
          outcome.status === 'ok' ? 0 : 1,
          Buffer.byteLength(outcome.output),
          outcome.status === 'ok' ? null : outcome.output,
          recordId,
        )
      return {
        ...outcome,
        sessionId: outcome.sessionId,
        loadSessionAdvertised: handle.loadSessionAdvertised === true,
      }
    } finally {
      try {
        handle.kill(9)
      } catch {
        /* exited */
      }
      void draining
    }
  } catch (error) {
    const detail = String((error as Error).message ?? error)
    writableDb()
      .query(`UPDATE run SET status='failed',latency_ms=?,exit_code=1,error=? WHERE record_id=?`)
      .run(Date.now() - started, detail, recordId)
    return {
      status: 'failed',
      output: detail,
      parsed: null,
      events: [] as NormalizedEvent[],
      sessionId: null,
      loadSessionAdvertised: false,
    }
  }
}
