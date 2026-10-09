import { z } from 'zod'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { strictlyAuthenticatedWorkerRun } from '../ask/worker-auth.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'

const noteRowsSchema = z.array(
  z.object({
    record_id: z.string().uuid(),
    label: z.string().min(1),
    text: z.string(),
    stale_at: z.string().nullable(),
    stale_reason: z.string().nullable(),
    promoted_task: z.string().nullable(),
    last_seen_at: z.string(),
  }),
)

export type HubNote = z.infer<typeof noteRowsSchema>[number]

export type FiledNoteAnchor = {
  cwd: string
  project: string
  files: { path: string; line: number; content: string }[]
  run_id: number | null
  branch: string | null
  commit: string | null
  session_id: string | null
}

export async function hubOutput(args: string[], cwd = process.cwd()): Promise<string> {
  const child = Bun.spawn([...bottegaEntryArgv('hub'), ...args], {
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
  input: { text: string; same_as?: string; new?: boolean },
  options: { cwd?: string; anchor?: FiledNoteAnchor } = {},
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
    ...(options.anchor ? ['--anchor-json', JSON.stringify(options.anchor)] : []),
    '--json',
  ]
  return parseFiledNoteOutput((await hubOutput(args, cwd)).trim())
}

export function parseFiledNoteOutput(output: string) {
  const parsed = z
    .object({
      record_id: z.string().uuid().nullable(),
      number: z.number().int().positive().nullable(),
      label: z.string().min(1).nullable(),
      sightings: z.number().int().positive().nullable(),
      candidates: z.array(
        z.object({
          record_id: z.string().uuid(),
          label: z.string().min(1),
          score: z.number(),
          text: z.string(),
        }),
      ),
    })
    .parse(JSON.parse(output) as unknown)
  const candidateNotes = parsed.candidates.map((candidate) => ({
    recordId: candidate.record_id,
    label: candidate.label,
  }))
  return {
    output: parsed.label
      ? `note ${parsed.label} filed; ${parsed.sightings} sighting${parsed.sightings === 1 ? '' : 's'}\nrecord ${parsed.record_id}`
      : `possible duplicate notes: ${parsed.candidates.map((candidate) => candidate.label).join(', ')}`,
    noteRecordId: parsed.record_id,
    noteLabel: parsed.label,
    candidateNotes,
  }
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

export async function hubNoteLabel(recordId: string, options: { cwd: string }): Promise<string> {
  const list = async (stale: boolean) => {
    const output = await hubOutput(
      ['note', 'list', ...(stale ? ['--stale'] : []), '--json'],
      options.cwd,
    )
    return noteRowsSchema.parse(JSON.parse(output) as unknown)
  }
  const notes = [...(await list(false)), ...(await list(true))]
  const note = notes.find((candidate) => candidate.record_id === recordId)
  if (!note) throw new Error(`hub cannot resolve note ${recordId}; run \`hub note list\``)
  return note.label
}
