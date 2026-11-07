// concern: task-cli-read
/** Reads one task through the CLI capability declared by the project register. */

import { startBounded } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import type { Project } from '../project/projects.ts'

export interface TaskCliReadResult {
  exitCode: number
  stdout: string
  stderr: string
}

export const readTaskThroughCli = (project: Project, key: string): Promise<TaskCliReadResult> =>
  startBounded(
    [...bottegaEntryArgv(PLATFORM_SLUG), 'task', 'show', key, '--project', project.name, '--json'],
    { budget: 'self-cli', cwd: project.path, env: { ...process.env } },
  )
