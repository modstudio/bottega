// concern: registered main-checkout mover adapter
/** Runs the one move-and-migrate command through the registered main checkout's own binary. */

import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { INSTALL_HOME_ENV } from '../../../shared/install-root.ts'

const ORCHESTRATOR_DATABASE_ENV = 'BOTTEGA_ORCHESTRATOR_DB'

export type MainCheckoutUpdateInvocation = {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
}

export type MainCheckoutUpdateResult = {
  exitCode: number
  output: string
}

/** Build the child identity without inheriting either installation or store overrides. */
export function mainCheckoutUpdateInvocation(
  projectPath: string,
  parentEnvironment: Record<string, string | undefined>,
): MainCheckoutUpdateInvocation {
  const {
    [INSTALL_HOME_ENV]: _installHome,
    [ORCHESTRATOR_DATABASE_ENV]: _databaseOverride,
    ...env
  } = parentEnvironment
  return {
    argv: [join(projectPath, 'bin', PLATFORM_SLUG), 'machine', 'update'],
    cwd: projectPath,
    env,
  }
}

/** Move a registered main checkout and migrate its stores under machine update's window. */
export function moveRegisteredMainCheckout(
  project: { path: string },
  parentEnvironment: Record<string, string | undefined> = process.env,
): MainCheckoutUpdateResult {
  const invocation = mainCheckoutUpdateInvocation(project.path, parentEnvironment)
  const result = Bun.spawnSync(invocation.argv, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = [result.stdout.toString().trim(), result.stderr.toString().trim()]
    .filter(Boolean)
    .join('\n')
  return { exitCode: result.exitCode, output }
}
