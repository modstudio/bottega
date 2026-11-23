// concern: cli
/** Registers setup detection and project-register adapters. Must not own setup policy. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Command, InvalidArgumentError, Option } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { repeatable } from '../../../shared/cli-repeat-guard.ts'
import { MACHINE_LEVELS, type MachineLevel } from '../../../shared/machine-config.ts'
import type { SetupService } from '../setup/setup-service.ts'
import { collect, log } from './support.ts'

const collectedOption = (flags: string, description: string) =>
  repeatable(new Option(flags, description).argParser(collect).default([]))

type SetupOptions = {
  in?: string[]
  json?: boolean
  yes?: boolean
  answers?: string
  level?: MachineLevel
  include?: string[]
}

function parseMachineLevel(value: string): MachineLevel {
  if (MACHINE_LEVELS.includes(value as MachineLevel)) return value as MachineLevel
  throw new InvalidArgumentError(`accepted values are ${MACHINE_LEVELS.join(', ')}`)
}

async function levelAnswer(options: SetupOptions): Promise<Record<string, string>> {
  const { MACHINE_LEVEL_QUESTION_ID } = await import('../setup/setup-engine.ts')
  return options.level ? { [MACHINE_LEVEL_QUESTION_ID]: options.level } : {}
}

function inheritedSetupOptions(options: SetupOptions, command: Command): SetupOptions {
  return { ...(command.optsWithGlobals() as SetupOptions), ...options }
}

function inputs(options: SetupOptions): string[] {
  return options.in?.length ? options.in : [process.cwd()]
}

const includedFolders = (options: SetupOptions): string[] =>
  (options.include ?? []).map((folder) => resolve(folder))

async function refuseWorkerRestore(): Promise<void> {
  if (!(await import('../run/run-process.ts')).isOrchWorkerProcess(process.env, process.pid)) return
  throw new Error(
    `refusing setup restore from an orchestrator worker run; an operator must run ${PLATFORM_SLUG} machine setup restore`,
  )
}

async function applyNonInteractiveSetup(
  options: SetupOptions,
  service: SetupService,
): Promise<void> {
  const { setupResultsRequireAttention } = await import('../setup/setup-apply.ts')
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
    ? await service.applyRecommended(
        folders,
        await levelAnswer(options),
        includedFolders(options),
      )
    : await service.apply(
        folders,
        answerValue,
        await levelAnswer(options),
        includedFolders(options),
      )
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
  migration: Parameters<SetupService['cancel']>[0],
  service: SetupService,
): Promise<void> {
  const reversed = await service.cancel(migration)
  if (reversed) log(reversed)
}

async function applyInteractiveSetup(options: SetupOptions, service: SetupService): Promise<void> {
  const [clack, interactive, auth, database, recordSession, setupApply] = await Promise.all([
    import('../setup/setup-clack.ts'),
    import('../setup/setup-interactive.ts'),
    import('../record/record-auth-command.ts'),
    import('../database/db.ts'),
    import('../record/record-session.ts'),
    import('../setup/setup-apply.ts'),
  ])
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    console.error(
      `${PLATFORM_SLUG} machine setup requires both stdin and stdout to be TTYs; use ${PLATFORM_SLUG} machine setup apply --yes or ${PLATFORM_SLUG} machine setup apply --answers <file>`,
    )
    process.exitCode = 2
    return
  }
  const folders = inputs(options)
  clack.introduceSetup(folders)
  const signIn = await interactive.runSetupSignIn(
    recordSession.cachedSignedInRecordUser()?.email ?? null,
    clack.clackSetupPrompter,
    (email, password) =>
      auth.signInCommand(
        email,
        async () => password,
        { log: clack.clackSetupPrompter.line },
        database.withDatabaseForMigrationStep,
      ),
  )
  if (signIn === interactive.SETUP_CANCEL) {
    process.exitCode = 130
    return
  }
  const prepared = await service.prepare(folders)
  const plan = await clack.gatherSetupPlan(
    () => Promise.resolve(prepared.plan),
    () => {
      process.exitCode = 130
    },
    Boolean(prepared.migration),
  )
  if (plan === interactive.SETUP_CANCEL) {
    await reversePreparedSetup(prepared.migration, service)
    return
  }
  let actionsStarted = false
  let outcome: Awaited<ReturnType<typeof interactive.runInteractiveSetup>>
  try {
    outcome = await interactive.runInteractiveSetup(
      plan,
      clack.clackSetupPrompter,
      (actions) => {
        actionsStarted = true
        return service.applyPreparedActions(actions, prepared.migration)
      },
      Boolean(prepared.migration),
      await levelAnswer(options),
    )
  } catch (error) {
    if (!actionsStarted) {
      await reversePreparedSetup(prepared.migration, service)
    }
    throw error
  }
  if (outcome.kind !== 'applied') {
    await reversePreparedSetup(prepared.migration, service)
  }
  if (outcome.kind === 'cancelled') process.exitCode = 130
  if (outcome.kind === 'applied' && setupApply.setupResultsRequireAttention(outcome.results)) {
    process.exitCode = 1
  }
}

export function register(program: Command, service?: SetupService): void {
  const setup = program
    .command('setup')
    .description('inspect and configure this machine interactively')
    .addOption(collectedOption('--in <folder>', 'folder to inspect'))
    .option('--level <record|full>', 'set the install level', parseMachineLevel)
    .allowExcessArguments(false)
    .action(async (options: SetupOptions) =>
      applyInteractiveSetup(
        options,
        service ?? (await import('../setup/setup-service.ts')).setupService,
      ),
    )
  setup
    .command('restore <backup-dir>')
    .description('restore a reversible environment migration backup')
    .allowExcessArguments(false)
    .action(async (directory: string) => {
      await refuseWorkerRestore()
      await (await import('../setup/setup-environment-runtime.ts')).restoreSetupEnvironment(
        directory,
      )
      log(`restored setup environment backup ${directory}`)
    })
  setup
    .command('facts')
    .description('inspect machine setup facts')
    .option('--json', 'write the setup facts as JSON')
    .allowExcessArguments(false)
    .action(async () =>
      log(JSON.stringify(await (await import('../setup/setup-facts.ts')).gatherSetupFacts())),
    )
  setup
    .command('plan')
    .description('plan recommended machine setup actions')
    .addOption(collectedOption('--in <folder>', 'folder to inspect'))
    .option('--json', 'write the setup plan as compact JSON')
    .option('--level <record|full>', 'answer the install-level question', parseMachineLevel)
    .addOption(collectedOption('--include <folder>', 'include an unregistered project folder'))
    .allowExcessArguments(false)
    .action(async (options: SetupOptions, command: Command) => {
      const resolved = inheritedSetupOptions(options, command)
      const activeService = service ?? (await import('../setup/setup-service.ts')).setupService
      const plan = await activeService.dryRun(
        inputs(resolved),
        await levelAnswer(resolved),
        includedFolders(resolved),
      )
      log(JSON.stringify(plan, null, resolved.json ? undefined : 2))
    })
  setup
    .command('apply')
    .description(
      'apply a machine setup plan without prompts; render machine hooks and settings, hydrate user canon, and possibly run `claude mcp add` or `claude mcp remove`',
    )
    .addOption(collectedOption('--in <folder>', 'folder to inspect'))
    .option('--yes', 'apply every recommended setup answer')
    .option('--answers <file>', 'JSON file containing explicit setup answers')
    .option('--json', 'write the setup result as compact JSON')
    .option('--level <record|full>', 'answer the install-level question', parseMachineLevel)
    .addOption(collectedOption('--include <folder>', 'include an unregistered project folder'))
    .allowExcessArguments(false)
    .action(async (options: SetupOptions, command: Command) =>
      applyNonInteractiveSetup(
        inheritedSetupOptions(options, command),
        service ?? (await import('../setup/setup-service.ts')).setupService,
      ),
    )
}
