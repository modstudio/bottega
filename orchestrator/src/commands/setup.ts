// concern: cli
/** Registers setup detection and project-register adapters. Must not own setup policy. */
import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { clackSetupPrompter, gatherSetupPlan, introduceSetup } from '../setup/setup-clack.ts'
import { gatherSetupFacts } from '../setup/setup-facts.ts'
import { runInteractiveSetup, SETUP_CANCEL } from '../setup/setup-interactive.ts'
import { planSetupActions, recommendedAnswers } from '../setup/setup-planner.ts'
import { applySetupPlan, setupService } from '../setup/setup-service.ts'
import { collect, log } from './support.ts'

type SetupOptions = { in?: string[]; json?: boolean; yes?: boolean; answers?: string }

function inputs(options: SetupOptions): string[] {
  return options.in?.length ? options.in : [process.cwd()]
}

export function register(program: Command): void {
  const setup = program
    .command('setup')
    .option('--in <folder>', 'folder to inspect', collect, [])
    .allowExcessArguments(false)
    .action(async (options: SetupOptions) => {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        console.error(
          'orch setup requires both stdin and stdout to be TTYs; use orch setup apply --yes or orch setup apply --answers <file>',
        )
        process.exitCode = 2
        return
      }
      const folders = inputs(options)
      introduceSetup(folders)
      const plan = await gatherSetupPlan(
        () => setupService.plan(folders),
        () => {
          process.exitCode = 130
        },
      )
      if (plan === SETUP_CANCEL) return
      const outcome = await runInteractiveSetup(plan, clackSetupPrompter, applySetupPlan)
      if (outcome.kind === 'cancelled') process.exitCode = 130
      if (
        outcome.kind === 'applied' &&
        outcome.results.some((result) => result.status === 'refused')
      ) {
        process.exitCode = 1
      }
    })
  setup
    .command('facts')
    .requiredOption('--json')
    .allowExcessArguments(false)
    .action(async () => log(JSON.stringify(await gatherSetupFacts())))
  setup
    .command('plan')
    .option('--in <folder>', 'folder to inspect', collect, [])
    .option('--json')
    .allowExcessArguments(false)
    .action(async (options: SetupOptions) => {
      const plan = await setupService.plan(inputs(options))
      const diff = planSetupActions(plan, recommendedAnswers(plan))
      log(JSON.stringify({ ...plan, diff }, null, options.json ? undefined : 2))
    })
  setup
    .command('apply')
    .option('--in <folder>', 'folder to inspect', collect, [])
    .option('--yes')
    .option('--answers <file>')
    .option('--json')
    .allowExcessArguments(false)
    .action(async (options: SetupOptions) => {
      if (Boolean(options.yes) === Boolean(options.answers)) {
        throw new Error('orch setup apply requires exactly one of --yes or --answers <file>')
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
      const { plan, actions, results } = options.yes
        ? await setupService.applyRecommended(folders)
        : await setupService.apply(folders, answerValue)
      if (results.some((result) => result.status === 'refused')) process.exitCode = 1
      log(
        JSON.stringify(
          { ...plan, diff: actions, actions: results },
          null,
          options.json ? undefined : 2,
        ),
      )
    })
}
