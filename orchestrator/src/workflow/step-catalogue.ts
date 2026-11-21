// concern: workflows
/** Owns the shared, versioned workflow-step catalogue. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { orchDoValueOptionNames } from '../commands/do-options.ts'
import { db, sessionId, writableDb } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import { isMcpMode } from '../mcp/mcp-mode.ts'
import { workflowFactSources } from '../project/project-injection.ts'
import { projects } from '../project/projects.ts'
import { effectiveProjectSpace } from '../project-space.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { applyWorkflowWriteResponse } from '../record/record-cache-workflow.ts'
import { applyRecordWriteAuthority } from '../record/record-write-authority.ts'
import { workerStoreWriteRefusal } from '../worker-store-write.ts'
import { type AutonomyValue, autonomyStages, autonomyValues } from './autonomy.ts'
import { closeInstructionTaskTargetErrors } from './step-catalogue-close-instruction.ts'
import type {
  CatalogueSequence,
  CatalogueStep,
  FloorEntry,
  StepCatalogueDefinition,
} from './step-catalogue-definition.ts'
import { versionedLifecycle } from './versioned-lifecycle.ts'
import {
  type WorkflowDefinition,
  type WorkflowModeStep,
  workflowsAfterReplacement,
} from './workflow-definition.ts'
import { floorKinds, isFloorKind, mayCloseOnAgentSelfRuling } from './workflow-floor.ts'
import { workflowHostedSpace } from './workflow-hosted-space.ts'
import { workflowReadSpaceFor } from './workflow-read-space.ts'
import { checkWorkflowRendering, renderCheckRefusal } from './workflow-render-check.ts'
import { dispatchWaiverFacts } from './workflow-run-obligation.ts'
import { workflowPromotionReport } from './workflow-shared-promotion.ts'
import {
  type CataloguePromotionPorts,
  promoteSharedStepCatalogue,
} from './workflow-shared-promotion-store.ts'
import {
  inspectWorkflowSteps,
  validateCatalogueSequences,
  workflowConditionErrors,
} from './workflow-step-sequences.ts'

export type {
  CatalogueSequence,
  CatalogueStep,
  StepCatalogueDefinition,
} from './step-catalogue-definition.ts'

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
const REPOSITORY_FILE_PATH =
  /(?<![A-Za-z0-9_./:{-])((?:\.\/)?(?:\.?[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|md|json|jsonc|sql|py|php|yml|yaml|toml|sh))(?=$|[^A-Za-z0-9_/}-])/g
const PLATFORM_INVOCATION = `(?:${PLATFORM_SLUG}|\\S*\\/bin\\/${PLATFORM_SLUG})`
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function validateStepCatalogue(value: unknown): string[] {
  if (!object(value) || !Array.isArray(value.steps)) return ['steps must be an array']
  const errors: string[] = [],
    seen = new Set<string>()
  for (const [index, item] of value.steps.entries()) {
    if (!object(item)) {
      errors.push(`step ${index + 1} must be an object`)
      continue
    }
    validateIdentity(item, seen, errors)
    validateOutcomes(item, errors)
    validateRulingOutcomes(item, errors)
    validateOutcomeFloors(item, errors)
    validateReenter(item, errors)
    validateFloor(item, errors)
    validateNeeds(item, errors)
    validateRepositoryFileCitations(item, errors)
    errors.push(...closeInstructionTaskTargetErrors(item))
    validateDispatchPrompts(item, errors)
    validatePrescribedJobs(item, errors)
    validateDispatchObligations(item, errors)
  }
  errors.push(
    ...validateCatalogueSequences(
      value.sequences,
      new Set(
        value.steps.flatMap((item) =>
          object(item) && typeof item.slug === 'string' ? [item.slug] : [],
        ),
      ),
    ),
  )
  return [...new Set(errors)]
}

function validateRepositoryFileCitations(item: Record<string, unknown>, errors: string[]): void {
  if (typeof item.body !== 'string') return
  const slug = String(item.slug ?? '')
  for (const match of item.body.matchAll(REPOSITORY_FILE_PATH)) {
    const path = match[1]!
    errors.push(
      `step "${slug}" body cites repository file ${path}; a step is served to every project, so name the file through a project fact or the project's canon instead`,
    )
  }
}

export function unknownWorkflowFactNeeds(
  value: unknown,
): { step: string; source: string; error: string }[] {
  if (!object(value) || !Array.isArray(value.steps)) return []
  return value.steps.flatMap((item) => {
    if (!object(item) || !Array.isArray(item.needs)) return []
    const step = String(item.slug ?? '')
    return item.needs
      .map(String)
      .flatMap((source) =>
        (workflowFactSources as readonly string[]).includes(source)
          ? []
          : [{ step, source, error: `step "${step}" has invalid injection source "${source}"` }],
      )
  })
}

function validateOutcomes(item: Record<string, unknown>, errors: string[]): void {
  if (item.outcomes === undefined) return
  const slug = String(item.slug ?? '')
  if (!Array.isArray(item.outcomes) || item.outcomes.length === 0) {
    errors.push(`step "${slug}" outcomes must be a non-empty array`)
    return
  }
  if (item.outcomes.some((outcome) => typeof outcome !== 'string' || !SLUG.test(outcome)))
    errors.push(`step "${slug}" outcomes must be well-formed slugs`)
  if (new Set(item.outcomes).size !== item.outcomes.length)
    errors.push(`step "${slug}" outcomes must be unique`)
}

function validateRulingOutcomes(item: Record<string, unknown>, errors: string[]): void {
  if (item.rulingOutcomes === undefined) return
  const slug = String(item.slug ?? '')
  if (!Array.isArray(item.rulingOutcomes) || item.rulingOutcomes.length === 0) {
    errors.push(`step "${slug}" rulingOutcomes must be a non-empty array`)
    return
  }
  const outcomes = new Set(Array.isArray(item.outcomes) ? item.outcomes : [])
  if (
    new Set(item.rulingOutcomes).size !== item.rulingOutcomes.length ||
    item.rulingOutcomes.some((outcome) => typeof outcome !== 'string' || !outcomes.has(outcome))
  )
    errors.push(`step "${slug}" rulingOutcomes must be a non-empty unique subset of outcomes`)
}

function validateOutcomeFloors(item: Record<string, unknown>, errors: string[]): void {
  if (item.outcomeFloors === undefined) return
  const slug = String(item.slug ?? '')
  if (!object(item.outcomeFloors)) {
    errors.push(`step "${slug}" outcomeFloors must be an outcome-to-floor-list map`)
    return
  }
  const outcomes = new Set(Array.isArray(item.outcomes) ? item.outcomes : [])
  for (const [outcome, floors] of Object.entries(item.outcomeFloors)) {
    if (!outcomes.has(outcome))
      errors.push(`step "${slug}" outcomeFloors key "${outcome}" must be a declared outcome`)
    if (
      !Array.isArray(floors) ||
      floors.length === 0 ||
      new Set(floors).size !== floors.length ||
      floors.some((floor) => typeof floor !== 'string' || !isFloorKind(floor))
    )
      errors.push(
        `step "${slug}" outcomeFloors.${outcome} must be a non-empty unique list of known floor kinds`,
      )
  }
}

function validateReenter(item: Record<string, unknown>, errors: string[]): void {
  if (item.reenter === undefined) return
  const slug = String(item.slug ?? '')
  if (
    !object(item.reenter) ||
    Object.keys(item.reenter).length !== 2 ||
    typeof item.reenter.to !== 'string' ||
    typeof item.reenter.outcome !== 'string'
  ) {
    errors.push(`step "${slug}" reenter must be { to, outcome }`)
    return
  }
  if (!SLUG.test(item.reenter.to))
    errors.push(`step "${slug}" reenter.to must be a well-formed slug`)
  const outcomes = Array.isArray(item.outcomes) ? item.outcomes : []
  if (!outcomes.includes(item.reenter.outcome))
    errors.push(`step "${slug}" reenter.outcome must be one of the step's outcomes`)
}

function* backtickedCommands(body: string): Generator<string> {
  for (const match of body.matchAll(/`([^`\n]+)`/g)) yield match[1]!.trim()
}

function validateDispatchPrompts(item: Record<string, unknown>, errors: string[]): void {
  if (typeof item.body !== 'string') return
  const slug = String(item.slug ?? '')
  for (const command of backtickedCommands(item.body)) {
    if (
      !new RegExp(
        `^(?:(?:orch|\\S*\\/bin\\/orch)\\s+do|${PLATFORM_INVOCATION}\\s+run\\s+start)\\s+\\S+`,
      ).test(command)
    )
      continue
    if (!dispatchHasPromptOrFile(command))
      errors.push(
        `step "${slug}" dispatch "${command}" must include --file or a double-quoted argument`,
      )
  }
}

function prescribedJob(command: string): string | undefined {
  return command.match(
    new RegExp(`^${PLATFORM_INVOCATION}\\s+(?:run\\s+start|workflow\\s+dispatch)\\s+(\\S+)`),
  )?.[1]
}

function validatePrescribedJobs(item: Record<string, unknown>, errors: string[]): void {
  if (typeof item.body !== 'string') return
  const slug = String(item.slug ?? ''),
    declared = new Set(Array.isArray(item.jobs) ? item.jobs.map(String) : [])
  for (const command of backtickedCommands(item.body)) {
    const job = prescribedJob(command)
    if (job && !declared.has(job))
      errors.push(
        `step "${slug}" prescribes job "${job}" but does not declare it in jobs; add "${job}" to the step's jobs`,
      )
  }
}

function validateDispatchObligations(item: Record<string, unknown>, errors: string[]): void {
  const slug = String(item.slug ?? '')
  if (item.dispatch !== undefined && item.dispatch !== 'required')
    errors.push(`step "${slug}" dispatch must be "required"`)
  validateDispatchWaivers(item, slug, errors)
  validateJudgedJobs(item, slug, errors)
  validateWritingJobDispatch(item, slug, errors)
}

function validateDispatchWaivers(
  item: Record<string, unknown>,
  slug: string,
  errors: string[],
): void {
  if (item.dispatchWaivedBy === undefined) return
  if (item.dispatch !== 'required')
    errors.push(`step "${slug}" dispatchWaivedBy requires dispatch: required`)
  if (!Array.isArray(item.dispatchWaivedBy)) {
    errors.push(`step "${slug}" dispatchWaivedBy must be an array of dispatch waiver facts`)
    return
  }
  for (const fact of item.dispatchWaivedBy) {
    if (!(dispatchWaiverFacts as readonly unknown[]).includes(fact))
      errors.push(`step "${slug}" dispatchWaivedBy names unknown fact "${String(fact)}"`)
  }
}

function validateJudgedJobs(item: Record<string, unknown>, slug: string, errors: string[]): void {
  if (item.judges !== undefined) {
    if (!Array.isArray(item.judges)) errors.push(`step "${slug}" judges must be an array`)
    else
      for (const entry of item.judges)
        if (typeof entry !== 'string' || !(entry in JOBS))
          errors.push(`step "${slug}" judges unknown job "${String(entry)}"`)
  }
}

function validateWritingJobDispatch(
  item: Record<string, unknown>,
  slug: string,
  errors: string[],
): void {
  if (item.dispatch !== undefined || !Array.isArray(item.jobs)) return
  for (const job of item.jobs as string[]) {
    if (JOBS[job]?.needs.writesRepo)
      errors.push(
        `step "${slug}" declares repository-writing job "${job}" without dispatch; add "dispatch: required" to the step`,
      )
  }
}

type ShellToken = { value: string; quoted: boolean }

function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let value = '',
    quote: '"' | "'" | null = null,
    quoted = false,
    escaped = false
  const push = () => {
    if (value || quoted) tokens.push({ value, quoted })
    value = ''
    quoted = false
  }
  for (const character of command) {
    if (escaped) {
      value += character
      escaped = false
    } else if (character === '\\' && quote !== "'") escaped = true
    else if (quote) {
      if (character === quote) quote = null
      else value += character
    } else if (character === '"' || character === "'") {
      quote = character
      quoted = true
    } else if (/\s/.test(character)) push()
    else value += character
  }
  if (escaped) value += '\\'
  push()
  return tokens
}

function dispatchHasPromptOrFile(command: string): boolean {
  const tokens = shellTokens(command)
  let file = ''
  for (let index = 3; index < tokens.length; index++) {
    const token = tokens[index]!
    const option = consumeDispatchOption(tokens, index)
    if (option) {
      index = option.next
      if (option.file !== null) file = option.file
      continue
    }
    if (token.quoted && token.value.trim()) return true
  }
  return Boolean(file.trim())
}

function consumeDispatchOption(
  tokens: ShellToken[],
  index: number,
): { next: number; file: string | null } | null {
  const token = tokens[index]!
  if (!token.value.startsWith('--')) return null
  const [flag, inline] = token.value.slice(2).split('=', 2),
    valueKind = orchDoValueOptionNames.get(flag!)
  if (!valueKind) return { next: index, file: null }
  const following = tokens[index + 1],
    consumesFollowing =
      inline === undefined &&
      following !== undefined &&
      (valueKind === 'required' ||
        (!following.value.startsWith('--') && (flag !== 'mcp' || isMcpMode(following.value)))),
    optionValue = inline ?? (consumesFollowing ? following?.value : undefined)
  return {
    next: consumesFollowing ? index + 1 : index,
    file: flag === 'file' ? (optionValue ?? '') : null,
  }
}

function validateIdentity(
  item: Record<string, unknown>,
  seen: Set<string>,
  errors: string[],
): void {
  const slug = typeof item.slug === 'string' ? item.slug : ''
  if (!SLUG.test(slug)) errors.push(`step slug "${slug}" is not well-formed`)
  if (seen.has(slug)) errors.push(`duplicate step slug "${slug}"`)
  seen.add(slug)
  if (typeof item.title !== 'string' || !item.title.trim())
    errors.push(`step "${slug}" title must be non-empty`)
  if (typeof item.body !== 'string') errors.push(`step "${slug}" body must be a string`)
  validateJobsAndActions(item, slug, errors)
  if (!(autonomyValues as readonly string[]).includes(String(item.autonomy)))
    errors.push(`step "${slug}" has invalid autonomy "${String(item.autonomy)}"`)
  if (!(autonomyStages as readonly string[]).includes(String(item.stage)))
    errors.push(`step "${slug}" has invalid or missing stage "${String(item.stage)}"`)
}

function validateJobsAndActions(
  item: Record<string, unknown>,
  slug: string,
  errors: string[],
): void {
  if (!Array.isArray(item.jobs)) errors.push(`step "${slug}" jobs must be an array`)
  else
    for (const entry of item.jobs)
      if (typeof entry !== 'string' || !(entry in JOBS))
        errors.push(`step "${slug}" names unknown job "${String(entry)}"`)
  if (!Array.isArray(item.actions)) errors.push(`step "${slug}" actions must be an array`)
  else
    for (const entry of item.actions)
      if (entry !== 'pr-create' && entry !== 'pr-merge')
        errors.push(`step "${slug}" names unknown action "${String(entry)}"`)
}

/** Stored catalogue history remains readable without being revalidated. */
export function compatibleCatalogueStep(step: CatalogueStep): CatalogueStep {
  const legacy = step as unknown as Omit<
    CatalogueStep,
    'autonomy' | 'floor' | 'jobs' | 'actions'
  > & {
    autonomy: AutonomyValue | 'manual'
    floor: string[]
    job?: string | null
    jobs?: string[]
    actions?: string[]
  }
  const floor: FloorEntry[] = []
  for (const kind of legacy.floor) {
    const mapped = kind === 'human-ruling' ? 'ruling' : kind
    if (isFloorKind(mapped) || isFloorPlaceholder(mapped)) floor.push(mapped)
  }
  return {
    ...step,
    jobs: legacy.jobs ?? (legacy.job === null || legacy.job === undefined ? [] : [legacy.job]),
    actions: legacy.actions ?? [],
    autonomy: legacy.autonomy === 'manual' ? 'ask' : legacy.autonomy,
    floor,
  }
}

function validateDeferrable(
  item: Record<string, unknown>,
  floor: string[],
  errors: string[],
): void {
  const slug = String(item.slug ?? '')
  if (item.deferrable === undefined) return
  if (!Array.isArray(item.deferrable)) {
    errors.push(`step "${slug}" deferrable must be an array`)
    return
  }
  const deferrable = item.deferrable.map(String)
  if (new Set(deferrable).size !== deferrable.length)
    errors.push(`step "${slug}" deferrable has duplicates`)
  for (const kind of deferrable) {
    if (!floor.includes(kind))
      errors.push(`step "${slug}" deferrable kind "${kind}" is not on the floor`)
  }
}

function validateExpectedStatus(item: Record<string, unknown>, errors: string[]): void {
  if (item.expectedStatus === undefined) return
  const statuses = Array.isArray(item.expectedStatus) ? item.expectedStatus : [item.expectedStatus]
  if (
    statuses.length === 0 ||
    statuses.some((status) => typeof status !== 'string' || !status.trim())
  )
    errors.push(
      `step "${String(item.slug ?? '')}" expectedStatus must be a non-empty string or string list`,
    )
}

function validateExpectedExitCodes(item: Record<string, unknown>, errors: string[]): void {
  if (item.expectedExitCodes === undefined) return
  const slug = String(item.slug ?? '')
  if (!object(item.expectedExitCodes) || Object.keys(item.expectedExitCodes).length === 0) {
    errors.push(`step "${slug}" expectedExitCodes must be a non-empty object`)
    return
  }
  if (!Array.isArray(item.floor) || !item.floor.includes('command-exit'))
    errors.push(`step "${slug}" expectedExitCodes requires a command-exit floor`)
  const outcomes = new Set(Array.isArray(item.outcomes) ? item.outcomes : [])
  for (const [outcome, exitCode] of Object.entries(item.expectedExitCodes)) {
    if (!outcomes.has(outcome))
      errors.push(`step "${slug}" expectedExitCodes key "${outcome}" is not a step outcome`)
    if (!Number.isInteger(exitCode) || (exitCode as number) < 0)
      errors.push(`step "${slug}" expectedExitCodes.${outcome} must be a non-negative integer`)
  }
}

function validateFloor(item: Record<string, unknown>, errors: string[]): void {
  const slug = String(item.slug ?? '')
  if (!Array.isArray(item.floor) || item.floor.length === 0) {
    errors.push(`step "${slug}" floor must be non-empty`)
    return
  }
  const floor = item.floor.map(String)
  if (new Set(floor).size !== floor.length) errors.push(`step "${slug}" floor has duplicates`)
  const known = new Set<string>(floorKinds)
  for (const kind of floor)
    if (!known.has(kind) && !isFloorPlaceholder(kind))
      errors.push(`step "${slug}" has invalid floor kind "${kind}"`)
  validateDeferrable(item, floor, errors)
  if (item.requirePullRequest !== undefined && typeof item.requirePullRequest !== 'boolean')
    errors.push(`step "${slug}" requirePullRequest must be a boolean`)
  if (item.operatorRuling !== undefined && typeof item.operatorRuling !== 'boolean')
    errors.push(`step "${slug}" operatorRuling must be a boolean`)
  if (
    item.operatorRuling === true &&
    !floor.some(isFloorPlaceholder) &&
    ![
      mayCloseOnAgentSelfRuling({ floor, operatorRuling: false }, undefined),
      ...(Array.isArray(item.rulingOutcomes)
        ? item.rulingOutcomes.map((outcome) =>
            mayCloseOnAgentSelfRuling(
              {
                floor,
                rulingOutcomes: (item.rulingOutcomes as unknown[]).map(String),
                operatorRuling: false,
              },
              String(outcome),
            ),
          )
        : []),
      ...(object(item.outcomeFloors)
        ? Object.keys(item.outcomeFloors).map((outcome) =>
            mayCloseOnAgentSelfRuling(
              {
                floor,
                outcomeFloors: Object.fromEntries(
                  Object.entries(item.outcomeFloors as Record<string, unknown>).map(
                    ([key, value]) => [key, Array.isArray(value) ? value.map(String) : []],
                  ),
                ),
                operatorRuling: false,
              },
              outcome,
            ),
          )
        : []),
      object(item.reenter)
        ? mayCloseOnAgentSelfRuling({ floor, operatorRuling: false }, undefined, true)
        : false,
    ].some(Boolean)
  )
    errors.push(`step "${slug}" operatorRuling requires a ruling floor`)
  validateCommandEvidence(item, floor, errors)
  validateExpectedExitCodes(item, errors)
  validateExpectedStatus(item, errors)
}

function validateCommandEvidence(
  item: Record<string, unknown>,
  floor: string[],
  errors: string[],
): void {
  const slug = String(item.slug ?? '')
  if (
    item.commandEvidence !== undefined &&
    item.commandEvidence !== 'gate' &&
    item.commandEvidence !== 'pull-request'
  )
    errors.push(`step "${slug}" commandEvidence must be "gate" or "pull-request"`)
  if (
    item.commandEvidence === 'gate' &&
    !floor.includes('command-exit') &&
    !floor.some(isFloorPlaceholder)
  )
    errors.push(`step "${slug}" commandEvidence requires a command-exit floor`)
  if (
    item.commandEvidence === 'pull-request' &&
    !floor.includes('command-exit') &&
    !floor.includes('recorded-artifact') &&
    !floor.some(isFloorPlaceholder)
  )
    errors.push(
      `step "${slug}" pull-request commandEvidence requires a command-exit or recorded-artifact floor`,
    )
  if (
    item.commandEvidence !== undefined &&
    Array.isArray(item.deferrable) &&
    item.deferrable.includes('command-exit')
  )
    errors.push(
      `step "${slug}" cannot defer command-exit when commandEvidence is "${String(item.commandEvidence)}"`,
    )
}

const isFloorPlaceholder = (value: string): value is `{{${string}}}` =>
  /^\{\{[^{}]+\}\}$/.test(value)

function validateNeeds(item: Record<string, unknown>, errors: string[]): void {
  const slug = String(item.slug ?? '')
  if (!Array.isArray(item.needs)) {
    errors.push(`step "${slug}" needs must be an array`)
    return
  }
  const needs = item.needs.map(String)
  if (new Set(needs).size !== needs.length) errors.push(`step "${slug}" needs has duplicates`)
  errors.push(...unknownWorkflowFactNeeds({ steps: [item] }).map(({ error }) => error))
}

function requireCatalogue(value: unknown): asserts value is StepCatalogueDefinition {
  const errors = validateStepCatalogue(value)
  if (errors.length) refuseInvalidCatalogue(errors)
}

function refuseInvalidCatalogue(errors: string[]): never {
  throw new Error(`invalid step catalogue:\n${errors.map((error) => `- ${error}`).join('\n')}`)
}

export function importableStepCatalogueErrors(value: unknown): {
  errors: string[]
  unknownNeeds: ReturnType<typeof unknownWorkflowFactNeeds>
} {
  const unknownNeeds = unknownWorkflowFactNeeds(value)
  const ignored = new Set(unknownNeeds.map(({ error }) => error))
  return {
    errors: validateStepCatalogue(value).filter((error) => !ignored.has(error)),
    unknownNeeds,
  }
}

function requireImportableCatalogue(value: unknown): asserts value is StepCatalogueDefinition {
  const { errors } = importableStepCatalogueErrors(value)
  if (errors.length) refuseInvalidCatalogue(errors)
}

const lifecycle = versionedLifecycle<StepCatalogueDefinition>({
  noun: 'step catalogue',
  identityTable: 'step_catalogue',
  versionTable: 'step_catalogue_version',
  eventTable: 'step_catalogue_event',
  foreignKey: 'catalogue_record_id',
  validate(value) {
    requireCatalogue(value)
  },
})
const CATALOGUE = 'shared'
function assertCatalogueWriteAllowed(operation: string): void {
  const refusal = workerStoreWriteRefusal('workflow', operation, process.env)
  if (refusal) throw new Error(refusal)
}

const compatibleCatalogue = <T extends { definition: StepCatalogueDefinition }>(row: T): T => ({
  ...row,
  definition: {
    steps: row.definition.steps.map(compatibleCatalogueStep),
    ...(row.definition.sequences === undefined ? {} : { sequences: row.definition.sequences }),
  },
})
export const showStepCatalogue = (n?: number, d: Database = db()) =>
  compatibleCatalogue(lifecycle.show(CATALOGUE, n, d, workflowReadSpaceFor(d, null)))
export const productionStepCatalogue = (d: Database = db()) =>
  compatibleCatalogue(lifecycle.production(CATALOGUE, d, workflowReadSpaceFor(d, null)))
export function selectedStepCatalogue(
  n: number | undefined,
  d: Database,
  spaceId: string | null,
): ReturnType<typeof showStepCatalogue> {
  const suffix = n === undefined ? "AND v.status='production'" : 'AND v.n=?'
  const row = d
    .query(
      `SELECT v.*,i.slug FROM step_catalogue_version v JOIN step_catalogue i ON i.record_id=v.catalogue_record_id WHERE i.slug=? AND i.space_id IS ? AND v.superseded_at IS NULL ${suffix}`,
    )
    .get(...(n === undefined ? [CATALOGUE, spaceId] : [CATALOGUE, spaceId, n])) as {
    definition: string
    [key: string]: unknown
  } | null
  if (!row)
    throw new Error(
      `step catalogue has no ${n === undefined ? 'production version' : `version ${n}`}${spaceId === null ? '' : ` in hosted space ${spaceId}`}${n === undefined ? '; promote one' : ''}`,
    )
  return compatibleCatalogue({
    ...row,
    definition: JSON.parse(row.definition) as StepCatalogueDefinition,
  }) as ReturnType<typeof showStepCatalogue>
}
export function showPinnedStepCatalogue(
  recordId: string,
  d: Database,
): ReturnType<typeof showStepCatalogue> {
  const row = d
    .query(
      'SELECT v.*,i.slug FROM step_catalogue_version v JOIN step_catalogue i ON i.record_id=v.catalogue_record_id WHERE v.record_id=?',
    )
    .get(recordId) as ({ definition: string } & Record<string, unknown>) | null
  if (!row) throw new Error(`pinned step catalogue version ${recordId} does not exist`)
  return compatibleCatalogue({
    ...row,
    definition: JSON.parse(row.definition) as StepCatalogueDefinition,
  }) as ReturnType<typeof showStepCatalogue>
}
export const setStepCatalogue = (
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
  destinationSpaceId?: string,
) => {
  assertCatalogueWriteAllowed('set step catalogue')
  return catalogueDraft(
    'set',
    definition,
    undefined,
    reason,
    author,
    d,
    undefined,
    undefined,
    destinationSpaceId,
  )
}
export const setStepCatalogueLocal = (
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => {
  return lifecycle.write(CATALOGUE, definition, reason, author, 'set', d)
}
const writeAuthor = (value?: string) => value?.trim() || sessionId() || 'unknown'
function catalogueDraft(
  event: 'set' | 'fork' | 'import',
  definition: unknown,
  from: number | undefined,
  reason: string | undefined,
  author: string | undefined,
  d: Database,
  project?: string,
  onHostedWrite?: (n: number) => void,
  destinationSpaceId?: string,
) {
  return applyRecordWriteAuthority({
    local: () =>
      event === 'import'
        ? importStepCatalogueLocal(definition, reason, author, d)
        : lifecycle.write(CATALOGUE, definition, reason, author, event, d),
    hosted: async () => {
      if (event === 'import') requireImportableCatalogue(definition)
      else requireCatalogue(definition)
      if (!reason?.trim()) throw new Error('reason is required')
      const spaceId = workflowHostedSpace(d, project, destinationSpaceId, effectiveProjectSpace)
      const result = await recordApiClient().draftWorkflow!(
        {
          kind: 'step_catalogue',
          slug: CATALOGUE,
          event,
          ...(event === 'fork'
            ? { from: from ?? null }
            : { definition: JSON.stringify(definition) }),
          author: writeAuthor(author),
          reason: reason.trim(),
          sessionId: sessionId(),
        },
        { destinationSpaceId: spaceId },
      )
      onHostedWrite?.(result.versions.at(-1)!.n)
      await applyWorkflowWriteResponse(d, 'step_catalogue', result)
      return selectedStepCatalogue(result.versions.at(-1)!.n, d, spaceId)
    },
  })
}
export const forkStepCatalogue = (
  from: number | undefined,
  reason: string | undefined,
  project: string,
  author?: string,
  d: Database = writableDb(),
) => {
  assertCatalogueWriteAllowed('fork step catalogue')
  return applyRecordWriteAuthority({
    local: () => {
      const source = selectedStepCatalogue(from, d, workflowReadSpaceFor(d, project))
      return lifecycle.write(CATALOGUE, source.definition, reason, author, 'fork', d)
    },
    hosted: async () => {
      if (!reason?.trim()) throw new Error('reason is required')
      const spaceId = workflowHostedSpace(d, project, undefined, effectiveProjectSpace)
      const result = await recordApiClient().draftWorkflow!(
        {
          kind: 'step_catalogue',
          slug: CATALOGUE,
          event: 'fork',
          from: from ?? null,
          author: writeAuthor(author),
          reason: reason.trim(),
          sessionId: sessionId(),
        },
        { destinationSpaceId: spaceId },
      )
      await applyWorkflowWriteResponse(d, 'step_catalogue', result)
      return selectedStepCatalogue(result.versions.at(-1)!.n, d, spaceId)
    },
  })
}
export const forkStepCatalogueLocal = (
  from: number | undefined,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => {
  const source = from === undefined ? productionStepCatalogue(d) : showStepCatalogue(from, d)
  return lifecycle.write(CATALOGUE, source.definition, reason, author, 'fork', d)
}
export const retireStepCatalogue = (
  n: number,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
  destinationSpaceId?: string,
) => {
  assertCatalogueWriteAllowed('retire step catalogue')
  return applyRecordWriteAuthority({
    local: () => lifecycle.retire(CATALOGUE, n, reason, author, d),
    hosted: async () => {
      if (!reason?.trim()) throw new Error('reason is required')
      const spaceId = workflowHostedSpace(d, undefined, destinationSpaceId, effectiveProjectSpace),
        current = d
          .query<{ n: number }, [string]>(
            `SELECT v.n FROM step_catalogue_version v JOIN step_catalogue c ON c.record_id=v.catalogue_record_id WHERE c.slug='shared' AND c.space_id=? AND v.status='production' AND v.superseded_at IS NULL`,
          )
          .get(spaceId)
      const result = await recordApiClient().retireWorkflow!(
        {
          kind: 'step_catalogue',
          slug: CATALOGUE,
          n,
          expectedProductionVersion: current?.n ?? null,
          author: writeAuthor(author),
          reason: reason.trim(),
          sessionId: sessionId(),
        },
        { destinationSpaceId: spaceId },
      )
      await applyWorkflowWriteResponse(d, 'step_catalogue', result)
      return selectedStepCatalogue(n, d, spaceId)
    },
  })
}
const retireStepCatalogueLocal = (
  n: number,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => lifecycle.retire(CATALOGUE, n, reason, author, d)
export function showResolvedStepCatalogue(project: string | null, n?: number, d: Database = db()) {
  return selectedStepCatalogue(n, d, workflowReadSpaceFor(d, project))
}

export function resolvedStepCatalogueVersions(project: string | null, d: Database = db()) {
  const spaceId = workflowReadSpaceFor(d, project)
  return lifecycle.versions(CATALOGUE, d, spaceId)
}

type ProductionWorkflowDefinition = {
  modes?: { slug?: string; steps?: WorkflowModeStep[] }[]
  steps?: unknown[]
}

function catalogueModePromotionErrors(
  workflowSlug: string,
  mode: { slug?: string; steps?: WorkflowModeStep[] },
  available: ReadonlySet<string>,
  currentSequences: readonly CatalogueSequence[],
  proposedSequences: readonly CatalogueSequence[],
): { errors: string[]; removedStepErrorCount: number } {
  const entries = mode.steps ?? []
  const current = inspectWorkflowSteps(entries, currentSequences, available)
  const errors = current.missingSteps.length
    ? [`${workflowSlug}: ${current.missingSteps.join(', ')}`]
    : []
  const proposed = inspectWorkflowSteps(entries, proposedSequences, available)
  if (proposed.missingSequences.length)
    errors.push(
      `${workflowSlug} mode ${mode.slug ?? ''}: sequence "${proposed.missingSequences[0]}" is absent from the catalogue; add and promote that sequence, or edit the workflow mode to remove the reference`,
    )
  else if (proposed.duplicateSteps.length)
    errors.push(
      `${workflowSlug} mode ${mode.slug ?? ''}: duplicate steps ${proposed.duplicateSteps.join(', ')}`,
    )
  else if (proposed.invalidOmissions.length) {
    const invalid = proposed.invalidOmissions[0]!
    errors.push(
      `${workflowSlug} mode ${mode.slug ?? ''}: sequence "${invalid.sequence}" cannot omit non-member step "${invalid.step}"`,
    )
  }
  return { errors, removedStepErrorCount: current.missingSteps.length ? 1 : 0 }
}

function cataloguePromotionReferenceErrors(
  definition: StepCatalogueDefinition,
  currentSequences: readonly CatalogueSequence[],
  rows: { slug: string; definition: string }[],
): { errors: string[]; workflowSlugs: string[]; otherErrorCount: number } {
  const available = new Set(definition.steps.map((step) => step.slug))
  const proposedSequences = definition.sequences ?? []
  const references = rows.flatMap((row) => {
    const workflow = JSON.parse(row.definition) as ProductionWorkflowDefinition
    if (workflow.steps) return [] // Legacy inline versions remain valid history and self-contained.
    const modes = (workflow.modes ?? []).map((mode) => {
      const promotion = catalogueModePromotionErrors(
        row.slug,
        mode,
        available,
        currentSequences,
        proposedSequences,
      )
      const conditionErrors = workflowConditionErrors(
        mode.slug ?? '',
        inspectWorkflowSteps(mode.steps ?? [], proposedSequences, available).detailed,
        definition.steps,
      )
      return {
        errors: [...promotion.errors, ...conditionErrors],
        removedStepErrorCount: promotion.removedStepErrorCount,
      }
    })
    const errors = modes.flatMap((mode) => mode.errors)
    const removedStepErrorCount = modes.reduce(
      (count, mode) => count + mode.removedStepErrorCount,
      0,
    )
    return errors.length ? [{ slug: row.slug, errors, removedStepErrorCount }] : []
  })
  return {
    errors: references.flatMap(({ errors }) => errors),
    workflowSlugs: references.flatMap(({ slug, removedStepErrorCount }) =>
      removedStepErrorCount ? [slug] : [],
    ),
    otherErrorCount: references.reduce(
      (count, reference) => count + reference.errors.length - reference.removedStepErrorCount,
      0,
    ),
  }
}

export class CatalogueProductionReferenceRefusal extends Error {
  readonly workflowSlugs: string[]
  readonly otherErrorCount: number

  constructor(workflowSlugs: string[], errors: string[], otherErrorCount = 0) {
    super(
      `step catalogue changes references used by production workflows:\n${errors.map((line) => `- ${line}`).join('\n')}\nfix: keep the named sequences and reached steps, or promote workflow drafts that remove those references first`,
    )
    this.workflowSlugs = workflowSlugs
    this.otherErrorCount = otherErrorCount
  }
}

export function catalogueProductionReferenceRefusal(
  error: unknown,
): CatalogueProductionReferenceRefusal | null {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof CatalogueProductionReferenceRefusal) return current
    seen.add(current)
    current = current.cause
  }
  return null
}

export function promoteStepCatalogue(
  n: number,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
  project?: string,
  destinationSpaceId?: string,
) {
  assertCatalogueWriteAllowed('promote step catalogue')
  return applyRecordWriteAuthority({
    local: () => {
      promoteStepCatalogueLocal(n, reason, author, d)
      return workflowPromotionReport(n, { changed: [null], overrides: [], pinned: [] })
    },
    hosted: async () => {
      if (!reason?.trim()) throw new Error('reason is required')
      const spaceId = workflowHostedSpace(d, project, destinationSpaceId, effectiveProjectSpace),
        target = selectedStepCatalogue(n, d, spaceId)
      if (target.status === 'retired') throw new Error(`step catalogue version ${n} is not a draft`)
      const decision = await promoteSharedStepCatalogue(
        n,
        reason,
        spaceId,
        d,
        sharedStepCataloguePromotionPorts(author, d),
      )
      return workflowPromotionReport(n, decision)
    },
  })
}
export function promoteStepCatalogueLocal(
  n: number,
  reason: string | undefined,
  author: string | undefined,
  d: Database = writableDb(),
) {
  return lifecycle.promote(CATALOGUE, n, reason, author, d, (definition, database) => {
    cataloguePromotionPreflight(definition, database, null)
  })
}
function cataloguePromotionPreflight(
  definition: StepCatalogueDefinition,
  d: Database,
  spaceId: string | null,
  replacement?: { slug: string; definition: WorkflowDefinition },
): void {
  const validationErrors = validateStepCatalogue(definition)
  if (validationErrors.length) refuseInvalidCatalogue(validationErrors)
  const current = d
    .query<{ definition: string }, [string | null]>(
      `SELECT v.definition FROM step_catalogue c JOIN step_catalogue_version v ON v.catalogue_record_id=c.record_id
       WHERE c.slug='shared' AND c.space_id IS ? AND v.status='production' AND v.superseded_at IS NULL`,
    )
    .get(spaceId)
  const currentSequences = current
    ? ((JSON.parse(current.definition) as StepCatalogueDefinition).sequences ?? [])
    : []
  const currentWorkflowRows = d
    .query(
      `SELECT w.slug,v.definition FROM workflow w JOIN workflow_version v ON v.workflow_record_id=w.record_id
       WHERE v.status='production' AND v.superseded_at IS NULL AND w.space_id IS ?`,
    )
    .all(spaceId) as { slug: string; definition: string }[]
  const rows = replacement
    ? workflowsAfterReplacement(currentWorkflowRows, replacement.slug, replacement.definition)
    : currentWorkflowRows
  const missing = cataloguePromotionReferenceErrors(definition, currentSequences, rows)
  if (missing.errors.length)
    throw new CatalogueProductionReferenceRefusal(
      missing.workflowSlugs,
      missing.errors,
      missing.otherErrorCount,
    )
  const workflows = rows.map((row) => ({
    slug: row.slug,
    definition: JSON.parse(row.definition) as WorkflowDefinition,
  }))
  const refusal = renderCheckRefusal(
    // Promotion reads only placeholder failures, which do not depend on composition history.
    checkWorkflowRendering(workflows, definition, projects(undefined, d), new Map()),
  )
  if (refusal) throw new Error(refusal)
}

export function sharedStepCataloguePromotionPorts(
  author: string | undefined,
  d: Database,
): CataloguePromotionPorts {
  return {
    draftLocal: (version) =>
      importStepCatalogueLocal(JSON.parse(version.definition), version.reason, version.author, d).n,
    promoteLocal: (version, reason) => promoteStepCatalogueLocal(version, reason, author, d),
    preflight: (definition, spaceId, replacement) =>
      cataloguePromotionPreflight(definition, d, spaceId, replacement),
    author: () => writeAuthor(author),
  }
}

export function importStepCatalogue(
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
  project?: string,
  onHostedWrite?: (n: number) => void,
  destinationSpaceId?: string,
) {
  assertCatalogueWriteAllowed('import step catalogue')
  return catalogueDraft(
    'import',
    definition,
    undefined,
    reason,
    author,
    d,
    project,
    onHostedWrite,
    destinationSpaceId,
  )
}

const importStepCatalogueLocal = (
  definition: unknown,
  reason: string | undefined,
  author?: string,
  d: Database = writableDb(),
) => lifecycle.write(CATALOGUE, definition, reason, author, 'import', d, requireImportableCatalogue)

export const stepCatalogueLocalLifecycle = {
  set: setStepCatalogueLocal,
  promote: promoteStepCatalogueLocal,
  retire: retireStepCatalogueLocal,
  fork: forkStepCatalogueLocal,
  import: importStepCatalogueLocal,
}
