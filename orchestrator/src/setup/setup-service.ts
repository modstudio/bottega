// concern: setup-service
/** Owns setup plan assembly and application over plain folder and answer values. */

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { DB_PATH } from '../database/db.ts'
import { addProject, fillAbsentProjectSettings } from '../project/project-commands.ts'
import { projectByName, projects } from '../project/projects.ts'
import { requireRecordSpaceMembership } from '../record/record-space.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import { gatherRepositoryFactsReport } from './repository-facts.ts'
import {
  applySetupActions,
  type SetupActionResult,
  type SetupProjectService,
} from './setup-apply.ts'
import { proposeSetup, type SetupAgent, type SetupPlan } from './setup-engine.ts'
import type { PreparedStateFileMigration } from './setup-environment.ts'
import {
  prepareSetupStateFileMigration,
  reverseSetupStateFileMigration,
  setupEnvironmentService,
} from './setup-environment-runtime.ts'
import { gatherSetupFacts } from './setup-facts.ts'
import { captureLegacyPathSymlinks, pathDirectories } from './setup-legacy-path.ts'
import { stableMcpServers } from './setup-mcp.ts'
import { captureMcpConfigMigrations } from './setup-mcp-config-migration.ts'
import {
  planSetupActions,
  recommendedAnswers,
  type SetupAction,
  type SetupAnswers,
  validateSetupAnswers,
} from './setup-planner.ts'
import { assertMcpRegistrationWriteAllowed } from './setup-registration-write.ts'
import { decideStateFileMove, defaultStateFilePair } from './setup-state-file.ts'

type SetupApplyOutcome = {
  plan: SetupPlan
  actions: SetupAction[]
  results: SetupActionResult[]
}

type SetupStateFilePlan = {
  kind: 'migrate-state-file'
  oldPath: string
  newPath: string
  status: 'planned' | 'refused'
  message: string
}

type SetupDryRun =
  | (SetupPlan & { diff: SetupAction[] })
  | { stateFileMigration: SetupStateFilePlan; diff: [SetupStateFilePlan] }

export class SetupAnswersRefusedError extends Error {}

export type SetupService = {
  plan(folders: string[]): Promise<SetupPlan>
  dryRun(folders: string[]): Promise<SetupDryRun>
  prepare(
    folders: string[],
  ): Promise<{ plan: SetupPlan; migration: PreparedStateFileMigration | null }>
  cancel(migration: PreparedStateFileMigration | null): Promise<string | null>
  applyPreparedActions(
    actions: SetupAction[],
    migration: PreparedStateFileMigration | null,
  ): Promise<SetupActionResult[]>
  apply(folders: string[], answers: unknown): Promise<SetupApplyOutcome>
  applyRecommended(folders: string[]): Promise<SetupApplyOutcome>
}

export type SetupServiceAdapters = {
  plan(folders: string[]): Promise<SetupPlan>
  prepareStateFileMigration?: () => Promise<PreparedStateFileMigration | null>
  reverseStateFileMigration?: (migration: PreparedStateFileMigration) => Promise<string>
  inspectStateFileMigration?: () => Promise<SetupStateFilePlan | null>
  applyActions(
    actions: SetupAction[],
    migration?: PreparedStateFileMigration | null,
  ): Promise<SetupActionResult[]>
}

async function assembleSetupPlan(folders: string[]): Promise<SetupPlan> {
  const [machine, state] = await Promise.all([
    gatherSetupFacts(),
    Promise.resolve(readSetupState()),
  ])
  const repositories = await gatherRepositoryFactsReport(folders)
  const plan = proposeSetup(
    resolveWorktreeLifecycle,
    machine,
    repositories.repositories,
    state.projects,
    state.agents,
    repositories.notices,
    stableMcpServers(),
  )
  addMcpConfigMigrations(
    plan,
    homedir(),
    state.projects.map((project) => project.path),
  )
  addLegacyPathSymlinkRemovals(plan, pathDirectories(process.env.PATH))
  return plan
}

function addLegacyPathSymlinkRemovals(plan: SetupPlan, directories: readonly string[]): void {
  plan.legacyPathSymlinks = captureLegacyPathSymlinks(directories)
}

export function addMcpConfigMigrations(
  plan: SetupPlan,
  home: string,
  projectPaths: readonly string[],
): void {
  const configMigrations = captureMcpConfigMigrations(home, projectPaths)
  plan.mcpConfigMigrations = configMigrations.migrations
  plan.notices.push(
    ...configMigrations.notices.map(({ path, error }) => ({
      message: `MCP configuration ${path} could not be migrated: ${error}`,
      fix: `fix or remove ${path}, then re-run ${PLATFORM_SLUG} machine setup plan`,
    })),
  )
}

function readSetupState(): {
  projects: ReturnType<typeof projects>
  agents: SetupAgent[]
} {
  if (!existsSync(DB_PATH)) return { projects: [], agents: [] }
  const database = new Database(DB_PATH, { readonly: true })
  try {
    return {
      projects: projects(undefined, database),
      agents: database
        .query(
          `SELECT name,harness,enabled,
             CASE WHEN json_extract(probe_result,'$.ok')=1 THEN 1 ELSE 0 END AS probePassed
             FROM agent ORDER BY name`,
        )
        .all() as SetupAgent[],
    }
  } finally {
    database.close()
  }
}

function setupProjectService(): SetupProjectService {
  return {
    add: (input) => addProject(input, requireRecordSpaceMembership),
    fillAbsent: fillAbsentProjectSettings,
    currentRecipePath: (name) => projectByName(name)?.settings.worktree?.recipePath ?? null,
  }
}

function applySetupPlan(
  actions: SetupAction[],
  migration?: PreparedStateFileMigration | null,
): Promise<SetupActionResult[]> {
  if (actions.some((action) => action.kind === 'register-mcp')) {
    assertMcpRegistrationWriteAllowed()
  }
  return applySetupActions(
    actions,
    setupProjectService(),
    setupEnvironmentService,
    undefined,
    migration,
  )
}

export function createSetupService(adapters: SetupServiceAdapters): SetupService {
  async function reverseStoppedMigration(
    migration: PreparedStateFileMigration | null,
  ): Promise<string | null> {
    if (!migration) return null
    if (!adapters.reverseStateFileMigration) {
      throw new Error(`no state-file reversal adapter for backup ${migration.directory}`)
    }
    return adapters.reverseStateFileMigration(migration)
  }

  async function apply(
    folders: string[],
    answersForPlan: (plan: SetupPlan) => SetupAnswers,
  ): Promise<SetupApplyOutcome> {
    const migration = await (adapters.prepareStateFileMigration?.() ?? Promise.resolve(null))
    let plan: SetupPlan
    try {
      plan = await adapters.plan(folders)
    } catch (error) {
      const reversed = await reverseStoppedMigration(migration)
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(reversed ? `${detail}; ${reversed}` : detail)
    }
    let answers: SetupAnswers
    let actions: SetupAction[]
    try {
      answers = answersForPlan(plan)
      actions = planSetupActions(plan, answers)
    } catch (error) {
      const reversed = await reverseStoppedMigration(migration)
      const detail = error instanceof Error ? error.message : String(error)
      const message = reversed ? `${detail}; ${reversed}` : detail
      if (error instanceof SetupAnswersRefusedError) throw new SetupAnswersRefusedError(message)
      throw new Error(message)
    }
    return { plan, actions, results: await applyPreparedActions(actions, migration) }
  }

  async function applyPreparedActions(
    actions: SetupAction[],
    migration: PreparedStateFileMigration | null,
  ): Promise<SetupActionResult[]> {
    try {
      return await adapters.applyActions(actions, migration)
    } catch (error) {
      const reversed = await reverseStoppedMigration(migration)
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(reversed ? `${detail}; ${reversed}` : detail)
    }
  }

  return {
    plan: adapters.plan,
    async dryRun(folders) {
      const stateFileMigration = await (adapters.inspectStateFileMigration?.() ??
        Promise.resolve(null))
      if (stateFileMigration) return { stateFileMigration, diff: [stateFileMigration] }
      const plan = await adapters.plan(folders)
      return { ...plan, diff: planSetupActions(plan, recommendedAnswers(plan)) }
    },
    async prepare(folders) {
      const migration = await (adapters.prepareStateFileMigration?.() ?? Promise.resolve(null))
      try {
        return { plan: await adapters.plan(folders), migration }
      } catch (error) {
        const reversed = await reverseStoppedMigration(migration)
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(reversed ? `${detail}; ${reversed}` : detail)
      }
    },
    cancel: reverseStoppedMigration,
    applyPreparedActions,
    apply(folders, answerValue) {
      return apply(folders, (plan) => {
        try {
          return validateSetupAnswers(plan.questions, answerValue)
        } catch (error) {
          throw new SetupAnswersRefusedError(error instanceof Error ? error.message : String(error))
        }
      })
    },
    applyRecommended(folders) {
      return apply(folders, recommendedAnswers)
    },
  }
}

async function inspectSetupStateFileMigration(): Promise<SetupStateFilePlan | null> {
  const pair = defaultStateFilePair(process.env)
  if (!pair) return null
  const move = await decideStateFileMove(pair)
  if (move.kind === 'noop' || move.kind === 'leave-explicit') return null
  const refusal = move.kind === 'refuse' ? move.reason : null
  return {
    kind: 'migrate-state-file',
    oldPath: pair.oldPath,
    newPath: pair.newPath,
    status: refusal ? 'refused' : 'planned',
    message: refusal
      ? `${refusal}; after clearing this refusal, the rest of the setup plan follows the move`
      : 'Move the orchestrator state file first; the rest of the setup plan follows this move.',
  }
}

export const setupService = createSetupService({
  plan: assembleSetupPlan,
  prepareStateFileMigration: prepareSetupStateFileMigration,
  reverseStateFileMigration: reverseSetupStateFileMigration,
  inspectStateFileMigration: inspectSetupStateFileMigration,
  applyActions: applySetupPlan,
})
