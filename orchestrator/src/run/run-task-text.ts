import {
  resolveTrackerAgentActions,
  type TrackerProtocol,
} from '../../../shared/tracker-actions.ts'
import { readTaskText } from '../dispatch/task-key-lookup.ts'
import { projectByName, projectForTaskKey, projects } from '../project/projects.ts'
import { taskTextSection } from './run-pack-prompt.ts'

/** Carries task text only on the first turn of a keyed writing run. */
export async function initialRunTaskText([firstTurn, writesJob, key, projectName]: readonly [
  boolean,
  boolean,
  string | undefined,
  string | null,
]): Promise<string> {
  if (!firstTurn || !writesJob || !key) return ''
  const project = projectName ? projectByName(projectName) : projectForTaskKey(key, projects())
  if (!project) {
    return taskTextSection({
      task: { available: false, reason: 'the task project could not be resolved' },
      key,
      project: projectName ?? '(unknown)',
      getTool: 'tracker get tool',
      hub: false,
    })
  }
  const protocol = project.settings.tracker?.protocol
  const task = await readTaskText(project, key)
  const getTool = protocol
    ? (resolveTrackerAgentActions(protocol as TrackerProtocol, project.settings.tracker?.actions)
        .get ?? 'tracker get tool')
    : 'tracker get tool'
  return taskTextSection({
    task,
    key,
    project: project.name,
    getTool,
    hub: protocol === 'hub',
  })
}
