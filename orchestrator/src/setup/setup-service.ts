// concern: setup-service
/** Owns setup plan assembly and application over plain folder and answer values. */

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
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
import {
  planSetupActions,
  recommendedAnswers,
  type SetupAction,
  type SetupAnswers,
  validateSetupAnswers,
} from './setup-planner.ts'

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
  const orch = bottegaEntryArgv('orch')
  const ask = bottegaEntryArgv('ask-server')
  return proposeSetup(
    resolveWorktreeLifecycle,
    machine,
    repositories.repositories,
    state.projects,
    state.agents,
    repositories.notices,
    [
      { name: 'orch', command: orch[0]!, args: [...orch.slice(1), 'mcp'] },
      { name: 'orch-ask', command: ask[0]!, args: ask.slice(1) },
    ],
  )
}

function readSetupState(): { projects: ReturnType<typeof projects>; agents: SetupAgent[] } {
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
