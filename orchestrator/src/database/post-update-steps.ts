// concern: machine post-update policy and adapter
/**
 * Lists and runs the installed version's ordered post-update work. Machine update never installs
 * an older release because releaseDowngradeRefusal refuses it, so the installed binary always
 * carries machine post-update.
 */

import { realpathSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CHECKOUT_CLI_BINARY_ENV, resolveInstallationPaths } from '../../../shared/install-root.ts'
import {
  machineUpdateLockHeldEnvironment,
  withMachineUpdateLockUnlessHeld,
} from '../../../shared/update-lock.ts'
import { verifyMainCheckoutInvariant } from '../project/main-checkout-invariant.ts'
import { recordSessionPresent } from '../record/record-session.ts'
import { workflowTreeSyncCommands } from '../workflow/workflow-tree-sync-command.ts'
import { buildCheckoutCli } from './checkout-cli-build.ts'
import { setupIncrementalVacuumAfterMachineUpdate } from './database-commands.ts'
import {
  releaseHostedRowsAfterUpdate,
  retireDefaultProjectAfterUpdate,
} from './hosted-row-release.ts'
import { runPostPullStep } from './post-pull-step.ts'
import { databaseOverrideFreeEnvironment } from './release-update.ts'

type Presentation = { log(value: string): void }

export type PostUpdatePath = 'checkout' | 'distribution'

export type PostUpdateStep =
  | 'verify-main-checkout'
  | 'workflow-sync'
  | 'build-checkout-cli'
  | 'store-maintenance'
  | 'launch-agent-refresh'
  | 'hosted-row-release'
  | 'default-project-retirement'

const CHECKOUT_POST_UPDATE_STEPS: readonly PostUpdateStep[] = [
  'verify-main-checkout',
  'workflow-sync',
  'build-checkout-cli',
  'store-maintenance',
  'launch-agent-refresh',
  'verify-main-checkout',
  'hosted-row-release',
  'default-project-retirement',
]

const DISTRIBUTION_POST_UPDATE_STEPS: readonly PostUpdateStep[] = [
  'store-maintenance',
  'launch-agent-refresh',
  'hosted-row-release',
  'default-project-retirement',
]

/** Decide the complete ordered work owned by one update path. */
export function postUpdateSteps(path: PostUpdatePath): readonly PostUpdateStep[] {
  return path === 'checkout' ? CHECKOUT_POST_UPDATE_STEPS : DISTRIBUTION_POST_UPDATE_STEPS
}

export type PostUpdateInput =
  | { path: 'distribution' }
  | { path: 'checkout'; checkout: string; branch: string; beforePull: string }

export type PostUpdateDependencies = {
  git?: (cwd: string, args: string[]) => string
  verifyMainCheckout?: (
    path: string,
    trunk: string,
    git?: (cwd: string, args: string[]) => string,
  ) => void
  syncWorkflows?: (cwd: string, since: string) => void
  buildCli?: (cwd: string) => void
  maintainStore?: (presentation: Presentation) => void
  runLaunchAgentsRefreshVerb?: (binary: string) => void
  releaseHostedRows?: (presentation: Presentation) => Promise<void>
  retireUnusedDefaultLocalProject?: () => Promise<boolean>
  storeAttachedToHostedRecord?: () => boolean
  recordSessionPresent?: () => boolean
}

function runWorkflowSync(cwd: string, since: string): void {
  if (process.env.NODE_ENV === 'test') {
    throw new Error(
      'real machine-update workflow sync refuses side effects under the test runner; inject a syncWorkflows step',
    )
  }
  const reason = 'machine update synchronized the registered landing branch'
  const commands = workflowTreeSyncCommands(
    resolveInstallationPaths(cwd, {}).executable,
    cwd,
    reason,
    since,
  )
  for (const argv of [commands.import, commands.promote]) {
    runPostPullStep({
      argv,
      cwd,
      failureLabel: `${PLATFORM_SLUG} ${argv.slice(1, 3).join(' ')}`,
    })
  }
}

function runLaunchAgentsRefreshVerb(binary: string): void {
  const result = startBoundedSync([binary, 'machine', 'launch-agents', 'refresh'], {
    budget: 'machine-update',
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    const detail = stderr ? `: ${stderr}` : ''
    throw new Error(
      `launch-agent refresh failed with exit ${result.exitCode}${detail}; run ${binary} machine launch-agents refresh`,
    )
  }
}

function maintainStoreAfterUpdate(
  presentation: Presentation,
  maintainStore: (presentation: Presentation) => void,
): void {
  try {
    maintainStore(presentation)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    presentation.log(
      `incremental vacuum setup skipped: ${message}; retry with ${PLATFORM_SLUG} machine update`,
    )
  }
}

/** Run the shared ordered post-update list inside the installed version. */
export async function runPostUpdateSteps(
  presentation: Presentation,
  input: PostUpdateInput,
  deps: PostUpdateDependencies = {},
): Promise<void> {
  const checkout = input.path === 'checkout' ? input : null
  const binary = checkout
    ? resolveInstallationPaths(checkout.checkout, {}).executable
    : realpathSync(process.execPath)
  for (const step of postUpdateSteps(input.path)) {
    switch (step) {
      case 'verify-main-checkout':
        ;(deps.verifyMainCheckout ?? verifyMainCheckoutInvariant)(
          checkout!.checkout,
          checkout!.branch,
          deps.git,
        )
        break
      case 'workflow-sync':
        ;(deps.syncWorkflows ?? runWorkflowSync)(checkout!.checkout, checkout!.beforePull)
        break
      case 'build-checkout-cli':
        try {
          ;(deps.buildCli ?? buildCheckoutCli)(checkout!.checkout)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(
            `compiled checkout CLI build failed: ${detail}; rerun ${PLATFORM_SLUG} machine update`,
          )
        }
        break
      case 'store-maintenance':
        maintainStoreAfterUpdate(
          presentation,
          deps.maintainStore ?? setupIncrementalVacuumAfterMachineUpdate,
        )
        break
      case 'launch-agent-refresh':
        ;(deps.runLaunchAgentsRefreshVerb ?? runLaunchAgentsRefreshVerb)(binary)
        break
      case 'hosted-row-release':
        await (deps.releaseHostedRows ?? releaseHostedRowsAfterUpdate)(presentation)
        break
      case 'default-project-retirement':
        await retireDefaultProjectAfterUpdate(presentation, {
          recordSessionPresent: deps.recordSessionPresent ?? recordSessionPresent,
          retire: deps.retireUnusedDefaultLocalProject,
          storeAttached: deps.storeAttachedToHostedRecord,
        })
        break
      default: {
        const exhaustive: never = step
        return exhaustive
      }
    }
  }
}

type SpawnPostUpdate = (
  argv: string[],
  options: {
    env: Record<string, string | undefined>
    stdout: 'inherit'
    stderr: 'inherit'
  },
) => { exitCode: number }

function postUpdateArgv(binary: string, input: PostUpdateInput): string[] {
  const argv = [binary, 'machine', 'post-update', input.path]
  if (input.path === 'checkout') {
    argv.push(input.checkout, input.branch, input.beforePull)
  }
  return argv
}

type HandoffPostUpdateBase = {
  binary: string
  presentation: Presentation
  spawn?: SpawnPostUpdate
  environment?: Record<string, string | undefined>
}

export type HandoffPostUpdateInput = HandoffPostUpdateBase & { path: PostUpdateInput }

/** Hand post-update work to the installed binary and preserve its output. */
export function handoffPostUpdateSteps(input: HandoffPostUpdateInput): void {
  const argv = postUpdateArgv(input.binary, input.path)
  const environment = databaseOverrideFreeEnvironment({}, input.environment)
  if (input.path.path === 'checkout') delete environment[CHECKOUT_CLI_BINARY_ENV]
  Object.assign(environment, machineUpdateLockHeldEnvironment())
  const result = (input.spawn ?? Bun.spawnSync)(argv, {
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(`post-update steps failed with exit ${result.exitCode}; run ${argv.join(' ')}`)
  }
}

/** Run the hidden verb under the update lock unless its parent already holds it. */
export function postUpdateCommand(
  presentation: Presentation,
  input: PostUpdateInput,
  deps: PostUpdateDependencies = {},
): Promise<void> {
  return withMachineUpdateLockUnlessHeld(
    () => runPostUpdateSteps(presentation, input, deps),
    process.env,
    {},
    `machine post-update ${input.path}`,
  )
}
