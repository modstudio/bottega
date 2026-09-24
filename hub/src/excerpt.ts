import { readFileSync } from 'node:fs'

/**
 * Which lens of a fan-out a delegated run was, when the prompt names one.
 *
 * The runs table prints `prompt_head` as a run's description, and for a review
 * fan-out that is 200 characters of identical preamble: 187 of 336 runs share a
 * head byte-identical to another's, worst case 34. Those are exactly the rows
 * you need to tell apart, because a seven-way review is seven rows you are
 * about to score one at a time.
 *
 * WHAT DID NOT WORK, since it is worth not trying twice: building a general
 * "first interesting line" excerpt out of the full prompt. Measured against the
 * heads it replaced, it was WORSE - 194 collisions against 184 - because the
 * first substantial line of these prompts is a section label ("CONTEXT YOU
 * CANNOT DERIVE:") or a bare worktree path, which collide every bit as hard.
 * Tightening it to skip labels and paths moved it to 187. Still no better.
 *
 * So this extracts one field rather than summarizing prose: the lens, which is
 * the thing the rows actually differ by. Three spellings are live across the
 * workflows, and it is present on 152 of 319 runs; adding it takes runs that
 * are distinguishable by project, job and head from 142 to 160. A modest gain,
 * measured rather than assumed, and null when the prompt names no lens - the
 * head is fine for a run that is not one of a fan-out.
 *
 * Display only. It never decides what a run is attributed to.
 */
const LENS = [
  /\bstep\s+"([^"]+)"/, // get-workflow-step-tool ... step "agent-dead-code"
  /\bstep:\s*"([^"]+)"/, // get_workflow_step({ ..., step: "agent-correctness" })
  /^Review dimension:\s*(.+)$/m, // the inline packs
]

const cache = new Map<string, string | null>()

export function promptLens(path: string | null | undefined): string | null {
  if (!path) return null
  if (cache.has(path)) return cache.get(path) ?? null
  let out: string | null = null
  try {
    const text = readFileSync(path, 'utf8')
    for (const re of LENS) {
      const m = re.exec(text)
      if (m?.[1]) {
        out = m[1].trim().slice(0, 48)
        break
      }
    }
  } catch {
    /* the file may be cleaned up; that is not an error */
  }
  cache.set(path, out)
  return out
}
