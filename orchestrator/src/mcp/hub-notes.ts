import { z } from 'zod'
import { assetPath } from '../../../shared/install-root.ts'
import { strictlyAuthenticatedWorkerRun } from '../ask/ask.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'

const HUB = assetPath('bin', 'hub')

const noteRowsSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    text: z.string(),
    stale_at: z.string().nullable(),
    stale_reason: z.string().nullable(),
    promoted_task: z.string().nullable(),
    last_seen_at: z.string(),
  }),
)

export type HubNote = z.infer<typeof noteRowsSchema>[number]

export async function hubOutput(args: string[], cwd = process.cwd()): Promise<string> {
  const child = Bun.spawn([HUB, ...args], {
    cwd,
    env: { ...process.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `hub exited ${exitCode}`)
  }
  return stdout
}

export async function fileNote(
  input: { text: string; same_as?: number; new?: boolean },
  options: { cwd?: string } = {},
) {
  if (input.same_as && input.new) throw new Error('same_as and new are mutually exclusive')
  let cwd = options.cwd ?? process.cwd()
  const runId = Number(process.env.ORCH_RUN_ID ?? 0)
  const token = process.env.ORCH_RUN_TOKEN ?? ''
  if (options.cwd === undefined && runId > 0 && strictlyAuthenticatedWorkerRun(runId, token)) {
    const worker = db()
      .query<{ launch_cwd: string | null }, [number]>('SELECT launch_cwd FROM run WHERE id=?')
      .get(runId)
    if (worker?.launch_cwd) cwd = worker.launch_cwd
  }
  if (!projectAt(cwd)) throw new Error(`cannot file note: no registered project contains ${cwd}`)
  const args = [
    'note',
    'new',
    input.text,
    ...(input.same_as ? ['--same-as', String(input.same_as)] : input.new ? ['--new'] : []),
  ]
  return { output: (await hubOutput(args, cwd)).trim() }
}

export async function listHubNotes(project: string, options: { cwd: string }): Promise<HubNote[]> {
  const list = async (stale: boolean) => {
    const output = await hubOutput(
      ['note', 'list', '--project', project, ...(stale ? ['--stale'] : []), '--json'],
      options.cwd,
    )
    return noteRowsSchema.parse(JSON.parse(output) as unknown)
  }
  const [live, stale] = await Promise.all([list(false), list(true)])
  return [...live, ...stale]
}
