// concern: note curator orchestrator adapter
/** Dispatches schema-bound curator runs and reads their validated replies. */

import { z } from 'zod'
import { startBounded } from '../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { runtimeAssetPath } from '../../shared/runtime-assets.ts'
import { bottegaEntryArgv } from '../../shared/self-spawn.ts'
import { resolveOrchExecutable } from './orch-project-register.ts'

export type CuratorRunReply = { runId: string; reply: unknown }

async function run(args: string[], stdin?: string): Promise<string> {
  const command = [...bottegaEntryArgv(PLATFORM_SLUG, resolveOrchExecutable), ...args]
  const result = await startBounded(command, {
    budget: args[1] === 'wait' || args[1] === 'result' ? 'curator-run' : 'self-cli',
    env: process.env,
    stdin,
  })
  if (result.exitCode !== 0) {
    const output =
      result.stderr.trim() || result.stdout.trim() || `${PLATFORM_SLUG} exited ${result.exitCode}`
    throw new Error(output)
  }
  return result.stdout.trim()
}

export async function dispatchNoteEvaluationCurator(
  cwd: string,
  prompt: string,
): Promise<CuratorRunReply> {
  const schema = runtimeAssetPath('hub/src/note-curator-reply.schema.json')
  const reference = await run(
    ['run', 'start', 'understand', '--cwd', cwd, '--schema', schema],
    prompt,
  )
  if (!/^r[1-9][0-9]*$/.test(reference))
    throw new Error(`${PLATFORM_SLUG} run start returned an invalid run reference: ${reference}`)
  try {
    await run(['run', 'wait', reference])
    const result = await run(['run', 'result', reference, '--quiet'])
    return { runId: reference, reply: JSON.parse(result) }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`${reference}: ${message}`)
  }
}

export async function readNoteEvaluationRevision(
  project: string,
  revision: string,
): Promise<{ body: string }> {
  const result = await run([
    'doc',
    'revision',
    'project',
    project,
    'note-evaluation',
    revision,
    '--json',
  ])
  return z.object({ body: z.string() }).passthrough().parse(JSON.parse(result))
}
