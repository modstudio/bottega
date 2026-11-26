// concern: note evaluation service
/** Owns the complete read, evaluate, curate, rank, and record pipeline. */

import { readLiveSeedClasses, runNoteClassPass } from './note-classification.ts'
import { curateEvaluationNotes } from './note-curation.ts'
import { rankNoteClasses } from './note-curation-decisions.ts'
import { evaluateNotePairs, noteEvaluationBody } from './note-evaluation.ts'
import { appendCurationRecord } from './note-evaluation-record.ts'
import { listProjectSlimNotes } from './note-read.ts'
import { writeNoteEvaluationRecord } from './orch.ts'
import { projects } from './projects.ts'

type Dependencies = {
  registeredProject(project: string): { path: string } | null
  listNotes: typeof listProjectSlimNotes
  evaluatePairs: typeof evaluateNotePairs
  readSeed: typeof readLiveSeedClasses
  classPass: typeof runNoteClassPass
  curate: typeof curateEvaluationNotes
  rank: typeof rankNoteClasses
  appendRecord: typeof appendCurationRecord
  writeRecord: typeof writeNoteEvaluationRecord
  now(): string
}

const dependencies: Dependencies = {
  registeredProject: (project) =>
    projects().find((candidate) => candidate.name === project) ?? null,
  listNotes: listProjectSlimNotes,
  evaluatePairs: evaluateNotePairs,
  readSeed: readLiveSeedClasses,
  classPass: runNoteClassPass,
  curate: curateEvaluationNotes,
  rank: rankNoteClasses,
  appendRecord: appendCurationRecord,
  writeRecord: writeNoteEvaluationRecord,
  now: () => new Date().toISOString(),
}

export async function evaluateNotes(
  project: string,
  options: { skipCurate: boolean },
  deps: Dependencies = dependencies,
): Promise<string> {
  const registered = deps.registeredProject(project)
  if (!registered) throw new Error(`unknown project '${project}'`)
  const [actionable, all] = await Promise.all([
    deps.listNotes({ project, actionable: true }),
    deps.listNotes({ project }),
  ])
  const notes = actionable.notes
  const result = await deps.evaluatePairs(project, notes, all.notes)
  let body = noteEvaluationBody(project, deps.now(), notes.length, result)
  if (!options.skipCurate) {
    const seed = await deps.readSeed()
    const classPass = await deps.classPass(notes, seed)
    const curation = await deps.curate(registered.path, classPass.remaining, result.clusters, seed)
    const proposals = [...classPass.proposals, ...curation.proposals]
    const ranking = deps.rank(notes, proposals, seed)
    body = deps.appendRecord(body, classPass, curation, proposals, ranking)
  }
  await deps.writeRecord(project, body)
  return body
}
