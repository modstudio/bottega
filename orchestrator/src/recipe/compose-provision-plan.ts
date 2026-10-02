// concern: built-in Compose lifecycle decisions
/** Plans Compose identity and commands from plain values. Must not inspect Docker or execute commands. */

import type { TrackedRecipe } from './recipe-schema.ts'

export type ComposeCommandPlan = {
  projectName: string
  up: string[]
  down: string[]
  downWithoutFiles: string[]
}

export function composeProjectName(projectName: string, rootRunId: number): string {
  const prefix = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
  return `${prefix ? `${prefix}-` : ''}orch-${rootRunId}`
}

export function composeCommandPlan(input: {
  recipe: TrackedRecipe
  projectName: string
  rootRunId: number
  mainComposeProjects: readonly string[]
}): ComposeCommandPlan | null {
  const compose = input.recipe.compose
  if (!compose) return null
  const projectName = composeProjectName(input.projectName, input.rootRunId)
  if (input.mainComposeProjects.includes(projectName)) {
    throw new Error(
      `derived Compose project ${projectName} belongs to a registered main checkout; change the registered project name so the derived worktree project is distinct`,
    )
  }
  const files = compose.files.flatMap((file) => ['-f', file])
  const envFile = compose.envFile ? ['--env-file', compose.envFile] : []
  return {
    projectName,
    up: [
      'docker',
      'compose',
      '-p',
      projectName,
      ...files,
      ...envFile,
      'up',
      '-d',
      ...(compose.wait ? ['--wait'] : []),
    ],
    down: [
      'docker',
      'compose',
      '-p',
      projectName,
      ...files,
      'down',
      '--volumes',
      '--remove-orphans',
    ],
    downWithoutFiles: [
      'docker',
      'compose',
      '-p',
      projectName,
      'down',
      '--volumes',
      '--remove-orphans',
    ],
  }
}
