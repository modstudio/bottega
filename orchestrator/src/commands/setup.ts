// concern: cli
/** Registers setup detection and project-register adapters. Must not own setup policy. */
import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { isOrchWorkerProcess } from '../run/run-process.ts'
import { setupResultsRequireAttention } from '../setup/setup-apply.ts'
import { clackSetupPrompter, gatherSetupPlan, introduceSetup } from '../setup/setup-clack.ts'
import { restoreSetupEnvironment } from '../setup/setup-environment-runtime.ts'
import { gatherSetupFacts } from '../setup/setup-facts.ts'
import { runInteractiveSetup, SETUP_CANCEL } from '../setup/setup-interactive.ts'
import { setupService } from '../setup/setup-service.ts'
import { collect, log } from './support.ts'

type SetupOptions = { in?: string[]; json?: boolean; yes?: boolean; answers?: string }

function inputs(options: SetupOptions): string[] {
  return options.in?.length ? options.in : [process.cwd()]
}

function refuseWorkerRestore(): void {
  if (!isOrchWorkerProcess(process.env, process.pid)) return
  throw new Error(
    `refusing setup restore from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine setup restore`,
  )
}

async function applyNonInteractiveSetup(options: SetupOptions): Promise<void> {
  if (Boolean(options.yes) === Boolean(options.answers)) {
    throw new Error(
      `${PLATFORM_SLUG} machine setup apply requires exactly one of --yes or --answers <file>`,
    )
  }
  const folders = inputs(options)
  let answerValue: unknown
  if (options.answers) {
    try {
      answerValue = JSON.parse(readFileSync(options.answers, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read setup answers ${options.answers}: ${error}`)
    }
  }
  const outcome = options.yes
    ? await setupService.applyRecommended(folders)
    : await setupService.apply(folders, answerValue)
  const { plan, actions, results } = outcome
  if (setupResultsRequireAttention(results)) process.exitCode = 1
  log(
    JSON.stringify(
      { ...plan, diff: actions, actions: results },
      null,
      options.json ? undefined : 2,
    ),
  )
}

async function reversePreparedSetup(
  migration: Parameters<typeof setupService.cancel>[0],
): Promise<void> {
  const reversed = await setupService.cancel(migration)
  if (reversed) log(reversed)
}

async function applyInteractiveSetup(options: SetupOptions): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    console.error(
      `${PLATFORM_SLUG} machine setup requires both stdin and stdout to be TTYs; use ${PLATFORM_SLUG} machine setup apply --yes or ${PLATFORM_SLUG} machine setup apply --answers <file>`,
    )
    process.exitCode = 2
    return
  }
  const folders = inputs(options)
  const prepared = await setupService.prepare(folders)
  introduceSetup(folders)
  const plan = await gatherSetupPlan(
    () => Promise.resolve(prepared.plan),
    () => {
      process.exitCode = 130
    },
    Boolean(prepared.migration),
  )
  if (plan === SETUP_CANCEL) {
    await reversePreparedSetup(prepared.migration)
    return
  }
  let actionsStarted = false
  let outcome: Awaited<ReturnType<typeof runInteractiveSetup>>
  try {
    outcome = await runInteractiveSetup(
      plan,
      clackSetupPrompter,
      (actions) => {
        actionsStarted = true
        return setupService.applyPreparedActions(actions, prepared.migration)
      },
      Boolean(prepared.migration),
    )
  } catch (error) {
    if (!actionsStarted) {
      await reversePreparedSetup(prepared.migration)
    }
    throw error
  }
  if (outcome.kind !== 'applied') {
    await reversePreparedSetup(prepared.migration)
  }
  if (outcome.kind === 'cancelled') process.exitCode = 130
  if (outcome.kind === 'applied' && setupResultsRequireAttention(outcome.results)) {
    process.exitCode = 1
  }
}

export function register(program: Command): void {
  const setup = program
    .command('setup')
    .description('inspect and configure this machine interactively')
    .option('--in <folder>', 'folder to inspect', collect, [])
    .allowExcessArguments(false)
    .action(applyInteractiveSetup)
  setup
    .command('restore <backup-dir>')
    .description('restore a reversible environment migration backup')
    .allowExcessArguments(false)
    .action(async (directory: string) => {
      refuseWorkerRestore()
      await restoreSetupEnvironment(directory)
      log(`restored setup environment backup ${directory}`)
    })
  setup
    .command('facts')
    .description('inspect machine setup facts')
    .option('--json', 'write the setup facts as JSON')
    .allowExcessArguments(false)
    .action(async () => log(JSON.stringify(await gatherSetupFacts())))
  setup
    .command('plan')
    .description('plan recommended machine setup actions')
    .option('--in <folder>', 'folder to inspect', collect, [])
    .option('--json', 'write the setup plan as compact JSON')
    .allowExcessArguments(false)
    .action(async (options: SetupOptions) => {
      const plan = await setupService.dryRun(inputs(options))
      log(JSON.stringify(plan, null, options.json ? undefined : 2))
    })
  setup
    .command('apply')
    .description('apply a machine setup plan without prompts')
    .option('--in <folder>', 'folder to inspect', collect, [])
    .option('--yes', 'apply every recommended setup answer')
    .option('--answers <file>', 'JSON file containing explicit setup answers')
    .option('--json', 'write the setup result as compact JSON')
    .allowExcessArguments(false)
    .action(applyNonInteractiveSetup)
}
