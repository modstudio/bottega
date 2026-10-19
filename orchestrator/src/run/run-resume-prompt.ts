// concern: resumed run prompt assembly
import { existsSync, readFileSync } from 'node:fs'
import { packResumePrompt } from '../contract/contract.ts'
import { db } from '../database/db.ts'

/** Assemble the exact prompt a resumed turn puts on argv. */
export function packedResumePrompt(job: string, turnPrompt: string, parentId: string): string {
  const root = db().query('SELECT prompt_path FROM run WHERE record_id=?').get(parentId) as {
    prompt_path: string | null
  } | null
  // Missing aged-out root prompts do not strand otherwise resumable chains.
  if (!root?.prompt_path || !existsSync(root.prompt_path)) {
    return packResumePrompt(job, turnPrompt, null)
  }
  return packResumePrompt(job, turnPrompt, readFileSync(root.prompt_path, 'utf8'))
}
