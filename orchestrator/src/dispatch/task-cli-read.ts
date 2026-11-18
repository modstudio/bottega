// concern: task-cli-read
/** Reads one task through the installed task reader. */

import type { Project } from '../project/projects.ts'
import { taskReader } from '../workflow/task-read-port.ts'

export interface TaskCliReadResult {
  exitCode: number
  stdout: string
  stderr: string
}

export const readTaskThroughCli = async (
  project: Project,
  key: string,
): Promise<TaskCliReadResult> => {
  try {
    return {
      exitCode: 0,
      stdout: JSON.stringify(taskReader().show(key, { project: project.name })),
      stderr: '',
    }
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    }
  }
}
