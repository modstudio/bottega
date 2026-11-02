// concern: registered main-checkout mover adapter
/** Runs the one move-and-migrate command through the registered main checkout's own binary. */

import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { INSTALL_HOME_ENV } from '../../../shared/install-root.ts'

const MAIN_STORE_OVERRIDE_ENV = `${PLATFORM_SLUG.toUpperCase()}_ORCHESTRATOR_DB`
const WEB_STORE_OVERRIDE_ENV = `${PLATFORM_SLUG.toUpperCase()}_HUB_DB`

export type MainCheckoutUpdateInvocation = {
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
}

export type MainCheckoutUpdateResult = {
  exitCode: number
  output: string
}

/** Decide whether moving this checkout also moves the running Bottega installation. */
export function movesRunningBottegaInstallation(
  embeddedDistribution: boolean,
  projectIsInstallationRoot: boolean,
): boolean {
  return !embeddedDistribution && projectIsInstallationRoot
}

/** Build the child identity without inheriting either installation or store overrides. */
export function mainCheckoutUpdateInvocation(
  projectPath: string,
  parentEnvironment: Record<string, string | undefined>,
): MainCheckoutUpdateInvocation {
  const {
    [INSTALL_HOME_ENV]: _installHome,
    [MAIN_STORE_OVERRIDE_ENV]: _databaseOverride,
    [WEB_STORE_OVERRIDE_ENV]: _hubDatabaseOverride,
    ...env
  } = parentEnvironment
  return {
    argv: [join(projectPath, 'bin', PLATFORM_SLUG), 'machine', 'update'],
    cwd: projectPath,
    env,
  }
}

/** Throw the one failure presentation shared by machine-update mover consumers. */
export function throwMainCheckoutUpdateFailure(result: MainCheckoutUpdateResult): void {
  if (result.exitCode === 0) return
  throw new Error(result.output || `${PLATFORM_SLUG} machine update exited ${result.exitCode}`)
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
