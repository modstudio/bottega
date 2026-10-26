// concern: run dispatch rulings
/** Resolves and renders the task rulings inherited by a dispatched run. */

import { inheritedRunLinks } from './run-claim-inheritance.ts'
import { admitNewRunReference } from './run-task-reference.ts'
import { renderTaskRulings } from './task-rulings.ts'
import { taskRulingsForDispatch } from './task-rulings-store.ts'

type DispatchLinks = { taskRecordId: string | null; projectRecordId: string | null }

function runDispatchRulingsSection(input: {
  resume: boolean
  project: string | null
  taskRecordId: string | null
}): { section: string; questionIds: string[] } {
  const rulings = taskRulingsForDispatch({
    resume: input.resume,
    project: input.project,
    taskRecordId: input.resume ? null : input.taskRecordId,
  })
  return {
    section: renderTaskRulings(rulings),
    questionIds: rulings.rulings.map((ruling) => ruling.questionRecordId),
  }
}

export async function prepareRunDispatchRulings(input: {
  firstTurn: boolean
  workspaceSource: 'new' | 'retained'
  parentRunRecordId: string | null
  projectName: string | null
  projectRecordId: string | null
  key: string | null
  repoJob: boolean
  callerCwd: string
  launchCwd?: string
  probe: boolean
}): Promise<{ section: string; questionIds: string[]; links: DispatchLinks | null }> {
  const inherited =
    input.workspaceSource === 'retained' ? inheritedRunLinks(input.parentRunRecordId!) : null
  const links = inherited
    ? { taskRecordId: inherited.taskRecordId, projectRecordId: inherited.projectRecordId }
    : input.firstTurn
      ? await admitNewRunReference({
          projectName: input.projectName,
          projectRecordId: input.projectRecordId,
          key: input.key,
          cwd: input.repoJob ? null : input.callerCwd,
          launchCwd: input.launchCwd ?? input.callerCwd,
          probe: input.probe,
        })
      : null
  return {
    ...runDispatchRulingsSection({
      resume: !input.firstTurn,
      project: input.projectName ?? inherited?.projectName ?? null,
      taskRecordId: links?.taskRecordId ?? null,
    }),
    links,
  }
}
