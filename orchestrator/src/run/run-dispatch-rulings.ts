// concern: run dispatch rulings
/** Resolves and renders the task rulings inherited by a dispatched run. */

import {
  type CarriedAttachmentSource,
  resolveCarriedAttachments,
} from './run-carried-attachments.ts'
import { inheritedRunLinks } from './run-claim-inheritance.ts'
import { admitNewRunReference } from './run-task-reference.ts'
import { initialRunTaskText } from './run-task-text.ts'
import { renderTaskRulings, taskRulingFreeText } from './task-rulings.ts'
import { taskRulingsForDispatch } from './task-rulings-store.ts'

type DispatchLinks = { taskRecordId: string | null; projectRecordId: string | null }
type TaskTextReader = NonNullable<Parameters<typeof initialRunTaskText>[1]>['readTaskText']
type AttachmentReader = NonNullable<
  Parameters<typeof resolveCarriedAttachments>[1]
>['readAttachment']

async function runDispatchRulingsSection(input: {
  resume: boolean
  project: string | null
  taskRecordId: string | null
}): Promise<{
  section: string
  questionIds: string[]
  attachmentSources: CarriedAttachmentSource[]
}> {
  const rulings = await taskRulingsForDispatch({
    resume: input.resume,
    project: input.project,
    taskRecordId: input.resume ? null : input.taskRecordId,
  })
  return {
    section: renderTaskRulings(rulings),
    questionIds: rulings.rulings.map((ruling) => ruling.questionRecordId),
    attachmentSources: rulings.rulings.map((ruling) => ({
      label: `task rulings (question ${ruling.questionRecordId})`,
      text: Object.values(taskRulingFreeText(ruling)).filter(Boolean).join('\n'),
    })),
  }
}

export async function prepareRunDispatchRulings(
  input: {
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
    writesJob?: boolean
    spec: string
  },
  dependencies: {
    taskTextReader?: TaskTextReader
    attachmentReader?: AttachmentReader
    warningWriter?: (warning: string) => void
  } = {},
): Promise<{
  section: string
  questionIds: string[]
  links: DispatchLinks | null
  taskText: string
  carriedAttachments: string
  attachmentWarnings: string[]
}> {
  const key = input.key
  const inherited =
    input.workspaceSource === 'retained' ? inheritedRunLinks(input.parentRunRecordId!) : null
  const links = inherited
    ? { taskRecordId: inherited.taskRecordId, projectRecordId: inherited.projectRecordId }
    : input.firstTurn
      ? await admitNewRunReference({
          projectName: input.projectName,
          projectRecordId: input.projectRecordId,
          key,
          cwd: input.repoJob ? null : input.callerCwd,
          launchCwd: input.launchCwd ?? input.callerCwd,
          probe: input.probe,
        })
      : null
  const rulings = await runDispatchRulingsSection({
    resume: !input.firstTurn,
    project: input.projectName ?? inherited?.projectName ?? null,
    taskRecordId: links?.taskRecordId ?? null,
  })
  const taskText = await initialRunTaskText(
    {
      firstTurn: input.firstTurn,
      writesJob: Boolean(input.writesJob),
      key: key ?? undefined,
      projectName: input.projectName,
    },
    { readTaskText: dependencies.taskTextReader },
  )
  const attachmentWarnings: string[] = []
  const warningWriter = dependencies.warningWriter ?? console.error
  const carriedAttachments = await resolveCarriedAttachments(
    [
      { label: 'spec', text: input.spec },
      ...rulings.attachmentSources,
      { label: 'task text', text: taskText, missing: 'warn' },
    ],
    {
      readAttachment: dependencies.attachmentReader,
      onWarning: (warning) => {
        warningWriter(`orch: warning: ${warning}`)
        attachmentWarnings.push(warning)
      },
    },
  )
  return {
    section: rulings.section,
    questionIds: rulings.questionIds,
    links,
    taskText,
    carriedAttachments,
    attachmentWarnings,
  }
}
