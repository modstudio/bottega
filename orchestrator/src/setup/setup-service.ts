// concern: setup-service
/** Owns setup plan assembly and application over plain folder and answer values. */

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { probeAgent } from '../agent/agent-probe.ts'
import { type AgentRow, addAgent, agentRowDeclaration } from '../agent/agent-registry.ts'
import { DB_PATH } from '../database/db.ts'
import { addProject, fillAbsentProjectSettings } from '../project/project-commands.ts'
import { projectAmong, projectByName, projects } from '../project/projects.ts'
import {
  readActiveSpaceAgentDeclarations,
  readSignedInHostedProjectNames,
  requireRecordSpaceMembership,
} from '../record/record-space.ts'
import { resolveWorktreeLifecycle } from '../worktree/worktree-lifecycle.ts'
import { gatherProviderCredentialTrustFacts } from './provider-credential-trust.ts'
import { gatherRepositoryFactsReport } from './repository-facts.ts'
import {
  declarationDrift,
  type LocalAgentDeclaration,
  missingDeclaration,
  probesWithoutProject,
  probesWithProject,
} from './setup-agent-declarations.ts'
import {
  applySetupActions,
  type SetupActionResult,
  type SetupAgentService,
  type SetupProjectService,
} from './setup-apply.ts'
import {
  PROBE_AGENTS_QUESTION_ID,
  proposeSetup,
  REGISTER_AGENTS_QUESTION_ID,
  type SetupAgent,
  type SetupPlan,
} from './setup-engine.ts'
import type { PreparedStateFileMigration } from './setup-environment.ts'
import {
  prepareSetupStateFileMigration,
  reverseSetupStateFileMigration,
  setupEnvironmentService,
} from './setup-environment-runtime.ts'
import { gatherSetupFacts } from './setup-facts.ts'
import { nonInteractiveSetupFolders, selectSetupFolders } from './setup-folder-selection.ts'
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
  plan(folders: string[], included?: string[]): Promise<SetupPlan>
  dryRun(
    folders: string[],
    answers?: Partial<SetupAnswers>,
    included?: string[],
  ): Promise<SetupDryRun>
  prepare(
    folders: string[],
  ): Promise<{ plan: SetupPlan; migration: PreparedStateFileMigration | null }>
  cancel(migration: PreparedStateFileMigration | null): Promise<string | null>
  applyPreparedActions(
    actions: SetupAction[],
    migration: PreparedStateFileMigration | null,
  ): Promise<SetupActionResult[]>
  apply(
    folders: string[],
    answers: unknown,
    fixedAnswers?: Partial<SetupAnswers>,
    included?: string[],
  ): Promise<SetupApplyOutcome>
  applyRecommended(
    folders: string[],
    fixedAnswers?: Partial<SetupAnswers>,
    included?: string[],
  ): Promise<SetupApplyOutcome>
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
  let hostedProjectNames: string[] = []
  let hostedReadNotice: SetupPlan['notices'][number] | null = null
  try {
    hostedProjectNames = await readSignedInHostedProjectNames()
  } catch (error) {
    hostedReadNotice = {
      message: `hosted projects could not be read: ${error instanceof Error ? error.message : String(error)}`,
      fix: `${PLATFORM_SLUG} record sign-in`,
      blocking: false,
    }
  }
  const credentialTrustFacts = await gatherProviderCredentialTrustFacts(
    state.agents,
    state.projects,
  )
  const plan = proposeSetup(
    resolveWorktreeLifecycle,
    machine,
    repositories.repositories,
    state.projects,
    state.agents,
    repositories.notices,
    stableMcpServers(),
    hostedProjectNames,
    credentialTrustFacts,
  )
  if (hostedReadNotice) plan.notices.push(hostedReadNotice)
  await addDeclaredAgentsToPlan(plan, state.declarationAgents, state.projects)
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
      blocking: false,
    })),
  )
}

function readSetupState(): {
  projects: ReturnType<typeof projects>
  agents: SetupAgent[]
  declarationAgents: LocalAgentDeclaration[]
} {
  if (!existsSync(DB_PATH)) return { projects: [], agents: [], declarationAgents: [] }
  const database = new Database(DB_PATH, { readonly: true })
  try {
    const rows = database.query('SELECT * FROM agent ORDER BY name').all() as AgentRow[]
    return {
      projects: projects(undefined, database),
      agents: rows.map((row) => ({
        name: row.name,
        harness: row.harness,
        enabled: row.enabled,
        provider: row.provider,
        probePassed: row.probe_result ? Number(JSON.parse(row.probe_result).ok === true) : 0,
      })),
      declarationAgents: rows.map((row) => ({
        ...agentRowDeclaration(row),
        enabled: Boolean(row.enabled),
        probedAt: row.probed_at,
      })),
    }
  } finally {
    database.close()
  }
}

export async function addDeclaredAgentsToPlan(
  plan: SetupPlan,
  localAgents: LocalAgentDeclaration[],
  registeredProjects: ReturnType<typeof projects>,
  readDeclarations = readActiveSpaceAgentDeclarations,
): Promise<void> {
  const read = await readDeclarations()
  if (read.kind === 'local-only') return
  if (read.kind === 'unreadable') {
    addUnreadableDeclarationsNotice(plan, read)
    return
  }
  const localByName = new Map(localAgents.map((agent) => [agent.name, agent]))
  const registrations = declaredAgentRegistrations(plan, read, localByName)
  const declaredNames = new Set(read.agents.map(({ name }) => name))
  const declaredLocal = localAgents.filter(({ name }) => declaredNames.has(name))
  const current = projectAmong(process.cwd(), registeredProjects)
  const projectPath = (current ?? registeredProjects[0])?.path ?? null
  const existingProbeNames = declaredLocal
    .filter(({ enabled, probedAt }) => enabled && probedAt === null)
    .map(({ name }) => name)
  plan.agentDeclarations = {
    registrations,
    existingProbeNames,
    projectPath,
    spaceSlug: read.space.slug,
  }
  if (registrations.length) {
    plan.questions.push({
      id: REGISTER_AGENTS_QUESTION_ID,
      question: `Register ${registrations.length} agents the space declares?`,
      options: [
        { id: 'register', label: 'Register', why: 'Add the declared agents to this machine.' },
        { id: 'skip', label: 'Skip', why: 'Leave the agents absent on this machine.' },
      ],
      recommendation: 'register',
      why: 'Setup never adds a space declaration without approval.',
    })
  }
  const probeNames = projectPath
    ? probesWithProject({ existingProbeNames, registrations, projectPath })
    : probesWithoutProject({ existingProbeNames, registrations })
  if (projectPath && probeNames.length) {
    plan.questions.push({
      id: PROBE_AGENTS_QUESTION_ID,
      question: `Probe ${probeNames.length} agents now?`,
      options: [
        { id: 'probe', label: 'Probe', why: 'Prove each agent before routing can use it.' },
        { id: 'skip', label: 'Skip', why: 'Leave the agents unprobed.' },
      ],
      recommendation: 'probe',
      why: 'Every agent probe requires explicit approval.',
    })
  } else if (!projectPath) {
    for (const name of probeNames) {
      plan.notices.push({
        message: `space agent ${name} cannot be probed because no project is registered`,
        fix: `${PLATFORM_SLUG} project add <path>, then ${PLATFORM_SLUG} agent probe ${name}`,
        blocking: false,
      })
    }
  }
}

function addUnreadableDeclarationsNotice(
  plan: SetupPlan,
  read: Extract<
    Awaited<ReturnType<typeof readActiveSpaceAgentDeclarations>>,
    { kind: 'unreadable' }
  >,
): void {
  const detail = read.detail ? `${read.cause} (${read.detail})` : read.cause
  plan.notices.push({
    message: `space agent declarations could not be read: ${detail}`,
    fix: `${PLATFORM_SLUG} record sign-in`,
    blocking: false,
  })
}

function declaredAgentRegistrations(
  plan: SetupPlan,
  read: Extract<Awaited<ReturnType<typeof readActiveSpaceAgentDeclarations>>, { kind: 'read' }>,
  localByName: ReadonlyMap<string, LocalAgentDeclaration>,
) {
  const registrations = []
  for (const declaration of read.agents) {
    const local = localByName.get(declaration.name)
    const missing = missingDeclaration(declaration, local)
    if (missing.kind === 'register') registrations.push(missing.registration)
    if (missing.kind === 'notice')
      plan.notices.push({
        message: `space agent ${declaration.name} declaration cannot be registered: ${missing.field} is not usable on this machine`,
        fix: `${PLATFORM_SLUG} agent share ${declaration.name} --space ${read.space.slug}`,
        blocking: false,
      })
    const fields = declarationDrift(declaration, local)
    if (fields.length)
      plan.notices.push({
        message: `space agent ${declaration.name} differs from its local row: ${fields.join(', ')}`,
        fix: `${PLATFORM_SLUG} agent share ${declaration.name} --space ${read.space.slug}`,
        blocking: false,
      })
  }
  return registrations
}

function setupProjectService(): SetupProjectService {
  return {
    add: (input) => addProject(input, requireRecordSpaceMembership),
    fillAbsent: fillAbsentProjectSettings,
    currentRecipePath: (name) => projectByName(name)?.settings.worktree?.recipePath ?? null,
  }
}

function setupAgentService(): SetupAgentService {
  return {
    add: addAgent,
    probe: (name, projectPath) =>
      probeAgent(name, {
        environment: process.env,
        path: process.env.PATH,
        cwd: projectPath,
      }),
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
    setupAgentService(),
  )
}

const selectedNonInteractivePlan = (plan: SetupPlan, included: string[]): SetupPlan =>
  selectSetupFolders(plan, nonInteractiveSetupFolders(plan, included))

function suppliedSetupAnswers(
  plan: SetupPlan,
  answerValue: unknown,
  fixedAnswers: Partial<SetupAnswers>,
): SetupAnswers {
  const fixed = Object.keys(fixedAnswers).length > 0
  const supplied =
    answerValue && typeof answerValue === 'object' && !Array.isArray(answerValue)
      ? { ...answerValue, ...fixedAnswers }
      : fixed
        ? fixedAnswers
        : answerValue
  return validateSetupAnswers(plan.questions, supplied)
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
    included: string[] = [],
  ): Promise<SetupApplyOutcome> {
    const migration = await (adapters.prepareStateFileMigration?.() ?? Promise.resolve(null))
    let plan: SetupPlan
    try {
      const gathered = await adapters.plan(folders)
      plan = selectedNonInteractivePlan(gathered, included)
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
    async plan(folders, included = []) {
      return selectedNonInteractivePlan(await adapters.plan(folders), included)
    },
    async dryRun(folders, fixedAnswers = {}, included = []) {
      const stateFileMigration = await (adapters.inspectStateFileMigration?.() ??
        Promise.resolve(null))
      if (stateFileMigration) return { stateFileMigration, diff: [stateFileMigration] }
      const gathered = await adapters.plan(folders)
      const plan = selectedNonInteractivePlan(gathered, included)
      return {
        ...plan,
        diff: planSetupActions(plan, {
          ...recommendedAnswers(plan),
          ...fixedAnswers,
        } as SetupAnswers),
      }
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
    apply(folders, answerValue, fixedAnswers = {}, included = []) {
      return apply(
        folders,
        (plan) => {
          try {
            return suppliedSetupAnswers(plan, answerValue, fixedAnswers)
          } catch (error) {
            throw new SetupAnswersRefusedError(
              error instanceof Error ? error.message : String(error),
            )
          }
        },
        included,
      )
    },
    applyRecommended(folders, fixedAnswers = {}, included = []) {
      return apply(
        folders,
        (plan) => ({ ...recommendedAnswers(plan), ...fixedAnswers }) as SetupAnswers,
        included,
      )
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
