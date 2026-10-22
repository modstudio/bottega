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

type SetupApplyOutcome = {
  plan: SetupPlan
  actions: SetupAction[]
  results: SetupActionResult[]
}

export class SetupAnswersRefusedError extends Error {}

export type SetupService = {
  plan(folders: string[]): Promise<SetupPlan>
  apply(folders: string[], answers: unknown): Promise<SetupApplyOutcome>
  applyRecommended(folders: string[]): Promise<SetupApplyOutcome>
}

export type SetupServiceAdapters = {
  plan(folders: string[]): Promise<SetupPlan>
  applyActions(actions: SetupAction[]): Promise<SetupActionResult[]>
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

export function applySetupPlan(actions: SetupAction[]): Promise<SetupActionResult[]> {
  if (actions.some((action) => action.kind === 'register-mcp')) {
    assertMcpRegistrationWriteAllowed()
  }
  return applySetupActions(actions, setupProjectService())
}

export function createSetupService(adapters: SetupServiceAdapters): SetupService {
  async function apply(
    folders: string[],
    answersForPlan: (plan: SetupPlan) => SetupAnswers,
  ): Promise<SetupApplyOutcome> {
    const plan = await adapters.plan(folders)
    const answers = answersForPlan(plan)
    const actions = planSetupActions(plan, answers)
    return { plan, actions, results: await adapters.applyActions(actions) }
  }

  return {
    plan: adapters.plan,
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

export const setupService = createSetupService({
  plan: assembleSetupPlan,
  applyActions: applySetupPlan,
})
