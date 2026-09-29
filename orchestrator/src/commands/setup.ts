// concern: cli
/** Registers setup detection and project-register adapters. Must not own setup policy. */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { DB_PATH } from '../database/db.ts'
import { addProject, fillAbsentProjectSettings } from '../project/project-commands.ts'
import { projects } from '../project/projects.ts'
import { requireRecordSpaceMembership } from '../record/record-space.ts'
import { gatherRepositoryFactsReport } from '../setup/repository-facts.ts'
import { applySetupActions } from '../setup/setup-apply.ts'
import { proposeSetup } from '../setup/setup-engine.ts'
import { gatherSetupFacts } from '../setup/setup-facts.ts'
import {
  planSetupActions,
  recommendedAnswers,
  validateSetupAnswers,
} from '../setup/setup-planner.ts'
import { collect, log } from './support.ts'

type SetupOptions = { in?: string[]; json?: boolean; yes?: boolean; answers?: string }

async function setupPlan(inputs: string[]) {
  const [machine, register] = await Promise.all([
    gatherSetupFacts(),
    Promise.resolve(readSetupProjects()),
  ])
  const repositories = gatherRepositoryFactsReport(inputs)
  const orch = bottegaEntryArgv('orch')
  const ask = bottegaEntryArgv('ask-server')
  return proposeSetup(machine, repositories.repositories, register, repositories.notices, [
    { name: 'orch', command: orch[0]!, args: [...orch.slice(1), 'mcp'] },
    { name: 'orch-ask', command: ask[0]!, args: ask.slice(1) },
  ])
}

function readSetupProjects() {
  if (!existsSync(DB_PATH)) return []
  const database = new Database(DB_PATH, { readonly: true })
  try {
    return projects(undefined, database)
  } finally {
    database.close()
  }
}

function inputs(options: SetupOptions): string[] {
  return options.in?.length ? options.in : [process.cwd()]
}

export function register(program: Command): void {
  const setup = program.command('setup')
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
      const plan = await setupPlan(inputs(options))
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
      const plan = await setupPlan(inputs(options))
      let answers = recommendedAnswers(plan)
      if (options.answers) {
        let value: unknown
        try {
          value = JSON.parse(readFileSync(options.answers, 'utf8'))
        } catch (error) {
          throw new Error(`cannot read setup answers ${options.answers}: ${error}`)
        }
        answers = validateSetupAnswers(plan.questions, value)
      }
      const actions = planSetupActions(plan, answers)
      const results = await applySetupActions(actions, {
        add: (input) => addProject(input, requireRecordSpaceMembership),
        fillAbsent: fillAbsentProjectSettings,
      })
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
