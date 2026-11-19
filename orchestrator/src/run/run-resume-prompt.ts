// concern: resumed run prompt assembly
import { existsSync, readFileSync } from 'node:fs'
import { packResumePrompt } from '../contract/contract.ts'
import { db } from '../database/db.ts'
import { resolveCarriedAttachments } from './run-carried-attachments.ts'

/** Pack a resumed turn with a carried-attachments section that has already been resolved. */
export function packedResumePrompt(
  job: string,
  turnPrompt: string,
  parentId: string,
  carriedAttachments: string,
): string {
  const carriedTurnPrompt = [carriedAttachments, turnPrompt].filter(Boolean).join('\n\n')
  const root = db().query('SELECT prompt_path FROM run WHERE record_id=?').get(parentId) as {
    prompt_path: string | null
  } | null
  // Missing aged-out root prompts do not strand otherwise resumable chains.
  if (!root?.prompt_path || !existsSync(root.prompt_path)) {
    return packResumePrompt(job, carriedTurnPrompt, null)
  }
  return packResumePrompt(job, carriedTurnPrompt, readFileSync(root.prompt_path, 'utf8'))
}

/** Resolve attachment tokens in a resumed turn before packing its exact argv prompt. */
export async function packedResumePromptWithCarriedAttachments(
  job: string,
  turnPrompt: string,
  parentId: string,
  dependencies: Parameters<typeof resolveCarriedAttachments>[1] = {},
): Promise<string> {
  const carriedAttachments = await resolveCarriedAttachments(
    [{ label: 'resume turn', text: turnPrompt }],
    dependencies,
  )
  return packedResumePrompt(job, turnPrompt, parentId, carriedAttachments)
}
