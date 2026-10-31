// concern: project-commands
/**
 * Knows project-register command semantics, validation, and presentation. Must
 * not know runs, routing, transports, reviews, the CLI, or worktrees by value.
 */
import { existsSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, tryWriteContention, writeTransaction } from '../database/db.ts'
import { listLenses, selectProjectProfile } from '../lens/lenses.ts'
import { credentialLinesFromRead } from '../mcp/mcp-credential-literal.ts'
import { readMcpConfigResult } from '../mcp/mcp-probe.ts'
import { effectiveProjectSpace, rememberProjectSpace } from '../project-space.ts'
import {
  pullRecordCataloguesForSpace,
  RecordCataloguePullError,
} from '../record/record-cache-catalogues.ts'
import { migrateCreate } from '../worktree/worktree-template.ts'
import { projectAddDecision } from './project-add-record.ts'
import { hostedProjectDestination, refuseHostedProjectSpaceChange } from './project-hosted-write.ts'
import { fillProjectRecordIds } from './project-record-identity.ts'
import { persistLocalProjectSet } from './project-rename.ts'
import {
  mergeProjectSettings,
  parseSettingsPatch,
  type SettingsPatchEffect,
  settingsPatchEffect,
} from './project-settings-patch.ts'
import { projectLifecycleForm } from './project-worktree-resolution.ts'
import {
  assertProjectRename,
  assertRegisterBranches,
  assertRegisterVisibility,
  isProjectRepository,
  type Project,
  type ProjectSettings,
  projectByName,
  projectRowByName,
  projects,
  pushProjects,
  registerBranchCheck,
  removeWrittenProject,
  retiredProjectByName,
  retireWrittenProject,
  sniffStack,
  unretireWrittenProject,
  upsertProject,
  validateProjectSettings,
  validateRegisterWrite,
  worktreeWarnings,
  writeHostedProject,
} from './projects.ts'

type ProjectFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
}
type ProjectPresentation = { log(...values: unknown[]): void; cwd(): string }

const enabledLensIds = (spaceId: string | null): string[] =>
  listLenses(db(), spaceId)
    .filter((lens) => lens.enabled)
    .map((lens) => lens.id)

function listedProjectJson(project: Project) {
  const { recordId, retiredAt, ...rest } = project
  return {
    ...rest,
    visibility: project.settings.visibility ?? null,
    record_id: recordId,
    repository: isProjectRepository(project),
    ...(retiredAt ? { retired_at: retiredAt } : {}),
    lifecycle_form: projectLifecycleForm(project),
    problems: validateProjectSettings(project.settings, 'strip', project.path),
    commit_hooks_skipped: true,
    gate: typeof project.settings.gate === 'string' ? project.settings.gate : null,
  }
}

function emptyProjectListMessage(retired: boolean): string {
  if (retired) return 'no retired projects.'
  return (
    'no projects registered.\n\n' +
    `  ${PLATFORM_SLUG} project add <path> [--name X] [--stack Y] [--no-canon] [--json]\n` +
    `  ${PLATFORM_SLUG} project retire <name> [--undo]\n\n` +
    'The stack is what lets routing tell "good at PHP" from "good at Vue";\n' +
    'two projects sharing one stack pool their evidence.'
  )
}

function printProjectRows(all: Project[], presentation: ProjectPresentation): void {
  for (const p of all) {
    const retiredMark = p.retiredAt ? '  retired' : ''
    presentation.log(
      `${p.name.padEnd(14)} ${(p.stack ?? '—').padEnd(22)} ` +
        `${p.canon ? 'canon' : '     '}  managed-context=${p.settings.managedContext === true}  ${p.path}${retiredMark}`,
    )
    const keys = Object.keys(p.settings)
    if (keys.length) presentation.log(`${' '.repeat(14)} settings: ${keys.join(', ')}`)
    for (const problem of validateProjectSettings(p.settings, 'strip', p.path)) {
      presentation.log(`${p.name}: ${problem}`)
    }
    // Reported, not enforced: a half-configured project should say so and
    // keep working. Every one of these is a state that has actually
    // happened rather than one imagined here.
    for (const w of worktreeWarnings(p)) {
      presentation.log(`${' '.repeat(14)} ! ${w}`)
    }
  }
}

function listProjectsCommand(flags: ProjectFlags, presentation: ProjectPresentation): void {
  const retired = flags.has('retired')
  const all = retired ? projects({ retired: true }) : projects()
  /**
   * PUBLISHED, because hub cannot import this concern and must not open
   * `orchestrator.db`.
   *
   * The boundary check forbids the import and a shared database would make
   * two concerns one, so what another concern needs is emitted here — the
   * same contract `bottega run state` already serves the dashboard under. A
   * project's identity, stack and settings are exactly the facts hub needs
   * to stop knowing four repository names of its own.
   */
  if (flags.has('json')) {
    presentation.log(JSON.stringify(all.map(listedProjectJson)))
    return
  }
  if (!all.length) {
    presentation.log(emptyProjectListMessage(retired))
    return
  }
  printProjectRows(all, presentation)
}

async function validateDeclaredSpace(
  settingsPatch: unknown,
  requireMembership: (space: string) => Promise<unknown>,
): Promise<void> {
  if (!settingsPatch || typeof settingsPatch !== 'object' || Array.isArray(settingsPatch)) return
  if (!Object.hasOwn(settingsPatch, 'space')) return
  const space = (settingsPatch as { space?: unknown }).space
  if (space === null || space === undefined) return
  if (typeof space !== 'string' || !space.trim()) return
  await requireMembership(space)
}

export type AddProjectInput = {
  path: string
  name: string
  stack: string | null
  canon: boolean
  settings: ProjectSettings
  allowIncomplete: boolean
  stackWasRequested?: boolean
  selectedSpace?: string
}

async function pullProjectAddCatalogues(
  input: AddProjectInput,
  targetSpace: { id: string; label: string },
): Promise<void> {
  try {
    await pullRecordCataloguesForSpace(db(), targetSpace.id)
  } catch (error) {
    if (!(error instanceof RecordCataloguePullError)) throw error
    const retry = `${PLATFORM_SLUG} project add ${JSON.stringify(input.path)} --name ${JSON.stringify(input.name)}${input.selectedSpace ? ` --space ${JSON.stringify(input.selectedSpace)}` : ''}`
    throw new Error(
      `failed to pull ${error.stream} catalogue for record space ${targetSpace.label}: ${error.message}\ncleared by: restore access to that hosted stream, then retry \`${retry}\``,
      { cause: error },
    )
  }
}

export async function addProject(
  input: AddProjectInput,
  requireMembership: (space: string) => Promise<unknown>,
): Promise<{ project: Project; wasRetired: boolean; adoptedSpace?: string }> {
  if (!existsSync(input.path)) throw new Error(`no such directory: ${input.path}`)
  const malformed = validateProjectSettings(input.settings, 'strict', input.path, {
    validateKeyPrefixes: Object.hasOwn(input.settings, 'keyPrefixes'),
    currentProjectName: input.name,
    register: projects(),
  })
  if (malformed.length) throw new Error(malformed.join('\n'))
  await validateDeclaredSpace(input.settings, requireMembership)
  const resolved = await projectAddDecision({
    name: input.name,
    requestedStack: input.stack,
    stackWasRequested: input.stackWasRequested === true,
    requestedSettings: input.settings,
    selectedSpace: input.selectedSpace,
  })
  const { decision, targetSpace } = resolved
  if (decision.kind === 'refuse') throw new Error(decision.reason)
  if (targetSpace) await pullProjectAddCatalogues(input, targetSpace)
  const candidate = {
    recordId: decision.kind === 'adopt' ? decision.recordId : newRecordId(),
    name: input.name,
    path: input.path,
    stack: decision.kind === 'adopt' ? decision.stack : input.stack,
    canon: input.canon,
    retiredAt: null,
    settings: decision.settings,
  }
  // Adopting merges the hosted row's settings with the requested ones, so the
  // merged row is read in strip mode; the requested settings were refused
  // strictly above.
  const adoptedMalformed = validateProjectSettings(candidate.settings, 'strip', input.path, {
    validateKeyPrefixes: Object.hasOwn(candidate.settings, 'keyPrefixes'),
    currentProjectName: input.name,
    register: projects(),
    enabledLensIds: enabledLensIds(targetSpace?.id ?? null),
  })
  if (adoptedMalformed.length) throw new Error(adoptedMalformed.join('\n'))
  const incomplete = incompleteWorktreeProblems(candidate)
  if (incomplete.length && !input.allowIncomplete) throw new Error(incomplete.join('\n'))
  assertRegisterBranches(candidate)
  verifyAndRecordVisibility(candidate)
  const wasRetired = Boolean(retiredProjectByName(input.name))
  const recordId =
    decision.kind === 'adopt' ? decision.recordId : await writeHostedProject(candidate)
  upsertProject({ ...candidate, recordId })
  if (targetSpace) rememberProjectSpace(db(), input.name, targetSpace.id)
  const project = projectByName(input.name)
  if (!project) throw new Error(`project ${input.name} was not registered`)
  return {
    project,
    wasRetired,
    ...(decision.kind === 'adopt' ? { adoptedSpace: decision.space } : {}),
  }
}

async function addProjectCommand(
  argv: string[],
  flags: ProjectFlags,
  presentation: ProjectPresentation,
  requireMembership: (space: string) => Promise<unknown>,
): Promise<void> {
  const { has, flag } = flags
  const path = (argv[2] ?? presentation.cwd()).replace(/\/$/, '')
  const name = flag('name') ?? path.split('/').filter(Boolean).pop()!
  // Sniffed only as a SUGGESTION, at the one moment a person is looking
  // straight at the project and can correct it. A guess that reruns on
  // every routing decision is a guess nobody ever reviews.
  const stack = flag('stack') ?? sniffStack(path)
  let settings = {} as ProjectSettings
  if (flag('settings')) {
    try {
      settings = JSON.parse(flag('settings')!) as typeof settings
    } catch (e) {
      throw new Error(`--settings must be JSON: ${e}`)
    }
  }
  const { project, wasRetired, adoptedSpace } = await addProject(
    {
      path,
      name,
      stack,
      canon: !has('no-canon'),
      settings,
      allowIncomplete: has('allow-incomplete'),
      stackWasRequested: has('stack'),
      selectedSpace: flag('space'),
    },
    requireMembership,
  )
  if (has('json')) {
    presentation.log(JSON.stringify(listedProjectJson(project)))
    return
  }
  if (adoptedSpace) {
    presentation.log(`adopted ${name} from record space ${adoptedSpace}  ${path}`)
  } else if (wasRetired) {
    presentation.log(`un-retired ${name}`)
  } else {
    presentation.log(
      `registered ${name}  ${stack ?? `(no stack — ${PLATFORM_SLUG} project set ${name} --stack ...)`}  ${path}`,
    )
  }
  for (const w of worktreeWarnings(projectByName(name)!)) {
    presentation.log(`${' '.repeat(14)} ! ${w}`)
  }
  for (const line of credentialLinesFromRead(project.name, readMcpConfigResult(project.path))) {
    presentation.log(`${' '.repeat(14)} ! ${line}`)
  }
}

export type FillAbsentProjectInput = {
  name: string
  fill: { stack?: string; settings: ProjectSettings }
}

/** Rewrite setup-owned tokens in every active project through the register write boundary. */
export async function migrateProjectSettingsText(
  rewrite: (settings: ProjectSettings) => { value: unknown; names: string[] },
): Promise<Array<{ project: string; names: string[] }>> {
  const changed: Array<{ project: string; names: string[] }> = []
  const plans: Array<{
    snapshot: Project
    settings: ProjectSettings
    names: string[]
    destinationSpaceId?: string
  }> = []
  for (const snapshot of [...projects(), ...projects({ retired: true })]) {
    const decision = rewrite(snapshot.settings)
    if (decision.names.length === 0) continue
    const settings = decision.value as ProjectSettings
    const destination = await hostedProjectDestination(snapshot.name, snapshot.settings)
    plans.push({
      snapshot,
      settings,
      names: decision.names,
      destinationSpaceId: destination?.destinationSpaceId,
    })
  }
  for (const plan of plans) {
    const { snapshot, settings } = plan
    const candidate = { ...snapshot, settings }
    const recordId = await writeHostedProject(candidate, plan.destinationSpaceId)
    writeTransaction(() => {
      const current = projectRowByName(snapshot.name)
      if (!current || JSON.stringify(current.settings) !== JSON.stringify(snapshot.settings)) {
        throw new Error(
          `project ${snapshot.name} changed during environment migration; re-run the command`,
        )
      }
      upsertProject({ ...candidate, recordId })
    })
    changed.push({ project: snapshot.name, names: plan.names })
  }
  return changed
}

export async function assertProjectSettingsMigrationWritable(
  rewrite: (settings: ProjectSettings) => { value: unknown; names: string[] },
): Promise<void> {
  for (const project of [...projects(), ...projects({ retired: true })]) {
    if (rewrite(project.settings).names.length === 0) continue
    await hostedProjectDestination(project.name, project.settings)
  }
}

export async function restoreMigratedProjectRows(rows: unknown[]): Promise<void> {
  for (const value of rows) {
    if (!value || typeof value !== 'object') throw new Error('invalid project row in setup backup')
    const project = value as Project
    if (typeof project.name !== 'string' || typeof project.path !== 'string') {
      throw new Error('invalid project row in setup backup')
    }
    const destination = await hostedProjectDestination(project.name, project.settings)
    const recordId = await writeHostedProject(project, destination?.destinationSpaceId)
    writeTransaction(() => upsertProject({ ...project, recordId }))
  }
}

const MAX_FILL_ABSENT_PROJECT_RESTARTS = 3

class FillAbsentProjectChanged extends Error {}

function fillAbsentSettings(current: Project, input: FillAbsentProjectInput): ProjectSettings {
  const settings = { ...current.settings }
  for (const key of Object.keys(input.fill.settings) as (keyof ProjectSettings)[]) {
    const value = input.fill.settings[key]
    if (key === 'worktree') {
      const currentWorktree = current.settings.worktree ?? {}
      const fillWorktree = value as NonNullable<ProjectSettings['worktree']>
      for (const worktreeKey of Object.keys(fillWorktree) as (keyof NonNullable<
        ProjectSettings['worktree']
      >)[]) {
        if (currentWorktree[worktreeKey] !== undefined) {
          throw new Error(
            `cannot fill worktree.${String(worktreeKey)} for ${input.name}: field is no longer absent`,
          )
        }
      }
      settings.worktree = { ...currentWorktree, ...fillWorktree }
      continue
    }
    if (current.settings[key] !== undefined) {
      throw new Error(`cannot fill ${String(key)} for ${input.name}: field is no longer absent`)
    }
    Object.assign(settings, { [key]: value })
  }
  return settings
}

function validatedFillCandidate(current: Project, input: FillAbsentProjectInput): Project {
  if (input.fill.stack !== undefined && current.stack !== null) {
    throw new Error(`cannot fill stack for ${input.name}: stack is no longer absent`)
  }
  const settings = fillAbsentSettings(current, input)
  const lensSpaceId = effectiveProjectSpace(db(), current.name)
  const malformed = validateRegisterWrite({
    merged: settings,
    supplied: input.fill.settings,
    projectPath: current.path,
    context: {
      validateKeyPrefixes: Object.hasOwn(input.fill.settings, 'keyPrefixes'),
      currentProjectName: current.name,
      register: projects(),
      enabledLensIds: enabledLensIds(lensSpaceId),
      enabledLensSpaceId: lensSpaceId,
    },
  })
  if (malformed.length) throw new Error(malformed.join('\n'))
  const candidate = {
    ...current,
    stack: input.fill.stack ?? current.stack,
    settings,
  }
  const incomplete = incompleteWorktreeProblems(candidate)
  if (incomplete.length) throw new Error(incomplete.join('\n'))
  return candidate
}

function canonicalSettingValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSettingValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalSettingValue(child)]),
  )
}

function sameProjectConfiguration(left: Project, right: Project): boolean {
  return (
    left.path === right.path &&
    left.stack === right.stack &&
    JSON.stringify(canonicalSettingValue(left.settings)) ===
      JSON.stringify(canonicalSettingValue(right.settings))
  )
}

type FillCandidate = { project: Project; error: null } | { project: null; error: unknown }

function fillCandidate(current: Project, input: FillAbsentProjectInput): FillCandidate {
  try {
    return { project: validatedFillCandidate(current, input), error: null }
  } catch (error) {
    return { project: null, error }
  }
}

async function writeHostedFillCandidate(
  snapshot: Project,
  candidate: FillCandidate,
): Promise<string> {
  if (!candidate.project) return snapshot.recordId
  const destination = await hostedProjectDestination(
    candidate.project.name,
    candidate.project.settings,
  )
  await refuseHostedProjectSpaceChange(snapshot, candidate.project.settings, destination)
  return writeHostedProject(candidate.project, destination?.destinationSpaceId)
}

/** Atomically fills setup-owned gaps without overwriting a value written since planning. */
export async function fillAbsentProjectSettings(input: FillAbsentProjectInput): Promise<void> {
  let candidate: Project | null = null
  for (let restart = 0; restart <= MAX_FILL_ABSENT_PROJECT_RESTARTS; restart += 1) {
    const snapshot = projectByName(input.name)
    if (!snapshot) throw new Error(`no project "${input.name}"`)
    const checked = fillCandidate(snapshot, input)
    const branchCheck = checked.project ? registerBranchCheck(checked.project) : null
    try {
      const recordId = await writeHostedFillCandidate(snapshot, checked)
      writeTransaction(() => {
        const current = projectByName(input.name)
        if (!current) throw new Error(`no project "${input.name}"`)
        const next = fillCandidate(current, input)
        if (
          !checked.project ||
          !next.project ||
          !sameProjectConfiguration(checked.project, next.project)
        ) {
          if (!checked.project && !next.project && sameProjectConfiguration(snapshot, current)) {
            throw next.error
          }
          throw new FillAbsentProjectChanged()
        }
        assertRegisterBranches(next.project, branchCheck!)
        upsertProject({ ...next.project, recordId })
        candidate = { ...next.project, recordId }
      })
      break
    } catch (error) {
      if (!(error instanceof FillAbsentProjectChanged)) throw error
      if (restart === MAX_FILL_ABSENT_PROJECT_RESTARTS) {
        throw new Error(`project ${input.name} kept changing; run the command again`)
      }
    }
  }
  if (!candidate) throw new Error(`project ${input.name} was not updated`)
}

function skipLegacyCreateMigration(
  project: ReturnType<typeof projectByName>,
  candidate: {
    settings: { worktree?: { create?: unknown } }
    path: string
  },
  problem: string,
): boolean {
  return (
    typeof project?.settings.worktree?.create === 'string' &&
    candidate.settings.worktree?.create === project.settings.worktree.create &&
    problem === 'worktree.create is a shell string; migrate it (DEV-308)'
  )
}

function incompleteWorktreeProblems(candidate: Parameters<typeof worktreeWarnings>[0]): string[] {
  return worktreeWarnings(candidate).filter(
    (warning) =>
      warning.startsWith('has a create command but no branch template') ||
      warning.startsWith('has a create command with a {seed} placeholder but no seeds list'),
  )
}

function patchedProjectSettings(project: Project, json: string | undefined) {
  if (json === undefined) {
    return { settings: project.settings, patch: undefined, before: null }
  }
  const patch = parseSettingsPatch(json)
  return {
    settings: mergeProjectSettings(project.settings, patch) as Project['settings'],
    patch,
    before: listedProjectJson(project).settings,
  }
}

function persistedSettingsEffect(
  before: Record<string, unknown> | null,
  project: Project,
): SettingsPatchEffect | null {
  return before ? settingsPatchEffect(before, listedProjectJson(project).settings) : null
}

function printSettingsEffect(
  effect: SettingsPatchEffect | null,
  presentation: ProjectPresentation,
): void {
  if (!effect) return
  const lines = [
    ...effect.added.map((path) => `added ${path}`),
    ...effect.changed.map((path) => `changed ${path}`),
    ...effect.removed.map((path) => `removed ${path}`),
  ]
  for (const line of lines.length ? lines : ['settings unchanged']) {
    presentation.log(`${' '.repeat(14)} ${line}`)
  }
}

function writesKeyPrefixes(patch: Record<string, unknown> | undefined): boolean {
  return Boolean(patch && Object.hasOwn(patch, 'keyPrefixes'))
}

function writesVisibility(patch: Record<string, unknown> | undefined): boolean {
  return Boolean(patch && Object.hasOwn(patch, 'visibility'))
}

function verifyAndRecordVisibility(candidate: Project): void {
  const repository = assertRegisterVisibility(candidate)
  if (repository) candidate.settings.visibilityRepository = repository
}

function verifyWrittenVisibility(
  patch: Record<string, unknown> | undefined,
  candidate: Project,
): void {
  if (writesVisibility(patch)) verifyAndRecordVisibility(candidate)
}

async function persistSetProject(
  currentName: string,
  nextName: string,
  previousTrunk: string | null,
  candidate: Parameters<typeof upsertProject>[0] & {
    settings: { trunk?: unknown }
  },
  destinationSpaceId?: string,
): Promise<void> {
  const renamed = nextName === currentName ? null : assertProjectRename(currentName, nextName)
  const recordId = await writeHostedProject(candidate, destinationSpaceId)
  const nextTrunk = typeof candidate.settings.trunk === 'string' ? candidate.settings.trunk : null
  persistLocalProjectSet(renamed, currentName, nextName, { ...candidate, recordId })
  if (previousTrunk === nextTrunk) return
  tryWriteContention({
    resourceKind: 'register',
    resourceKey: nextName,
    eventKind: 'invalidation',
    cause: `trunk ${previousTrunk ?? '(unset)'} -> ${nextTrunk ?? '(unset)'}`,
  })
}

async function setProjectCommand(
  argv: string[],
  flags: ProjectFlags,
  presentation: ProjectPresentation,
): Promise<void> {
  const name = argv[2]
  if (!name)
    throw new Error(
      `${PLATFORM_SLUG} project set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]`,
    )
  const project = projectByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  const {
    settings,
    patch: settingsPatch,
    before: settingsBefore,
  } = patchedProjectSettings(project, flags.flag('settings'))
  const nextName = flags.flag('name') ?? name
  const candidate = {
    recordId: project.recordId,
    name: nextName,
    path: flags.flag('path') ?? project.path,
    stack: flags.flag('stack') ?? project.stack,
    canon: flags.has('no-canon') ? false : flags.has('canon') ? true : project.canon,
    retiredAt: project.retiredAt,
    settings,
  }
  const lensSpaceId = effectiveProjectSpace(db(), name)
  // The patch's own keys are refused strictly; the row it merges into is read
  // in strip mode, so a key a newer binary wrote survives the update.
  const malformed = validateRegisterWrite({
    merged: candidate.settings,
    supplied: settingsPatch,
    projectPath: candidate.path,
    context: {
      validateKeyPrefixes:
        writesKeyPrefixes(settingsPatch) ||
        (nextName !== name && candidate.settings.keyPrefixes !== undefined),
      currentProjectName: name,
      projectNameAfterWrite: nextName,
      register: projects(),
      enabledLensIds: enabledLensIds(lensSpaceId),
      enabledLensSpaceId: lensSpaceId,
    },
  }).filter((problem) => !skipLegacyCreateMigration(project, candidate, problem))
  if (malformed.length) throw new Error(malformed.join('\n'))
  const incomplete = incompleteWorktreeProblems(candidate)
  if (incomplete.length && !flags.has('allow-incomplete')) throw new Error(incomplete.join('\n'))
  assertRegisterBranches(candidate)
  verifyWrittenVisibility(settingsPatch, candidate)
  const previousTrunk = typeof project.settings.trunk === 'string' ? project.settings.trunk : null
  const destination = await hostedProjectDestination(candidate.name, candidate.settings)
  await refuseHostedProjectSpaceChange(project, candidate.settings, destination)
  await persistSetProject(name, nextName, previousTrunk, candidate, destination?.destinationSpaceId)
  const persistedProject = projectByName(nextName)!
  if (flags.has('json')) {
    presentation.log(JSON.stringify(listedProjectJson(persistedProject)))
    return
  }
  presentation.log(`updated ${nextName}`)
  printSettingsEffect(persistedSettingsEffect(settingsBefore, persistedProject), presentation)
  for (const warning of worktreeWarnings(persistedProject)) {
    presentation.log(`${' '.repeat(14)} ! ${warning}`)
  }
  for (const line of credentialLinesFromRead(
    persistedProject.name,
    readMcpConfigResult(persistedProject.path),
  )) {
    presentation.log(`${' '.repeat(14)} ! ${line}`)
  }
}

async function retireProjectCommand(
  argv: string[],
  flags: ProjectFlags,
  presentation: ProjectPresentation,
): Promise<void> {
  const name = argv[2]
  if (!name) throw new Error(`${PLATFORM_SLUG} project retire <name> [--undo]`)
  if (flags.has('undo')) {
    await unretireWrittenProject(name)
    presentation.log(`un-retired ${name}`)
    return
  }
  const outcome = await retireWrittenProject(name)
  presentation.log(outcome === 'already-retired' ? `already retired ${name}` : `retired ${name}`)
}

async function fillProjectRecordIdsCommand(
  json: boolean,
  presentation: ProjectPresentation,
): Promise<void> {
  const rows = await fillProjectRecordIds()
  if (json) {
    presentation.log(JSON.stringify(rows))
    return
  }
  for (const row of rows) {
    presentation.log(`filled ${row.name}  ${row.recordId}  ${row.source}`)
  }
  presentation.log(`filled ${rows.length} project record id${rows.length === 1 ? '' : 's'}`)
}

async function pushProjectsCommand(
  json: boolean,
  presentation: ProjectPresentation,
): Promise<void> {
  const names = await pushProjects()
  presentation.log(
    json ? JSON.stringify(names) : `pushed ${names.length} project${names.length === 1 ? '' : 's'}`,
  )
}

export async function projectCommand(
  sub: string,
  argv: string[],
  flags: ProjectFlags,
  presentation: ProjectPresentation,
  dependencies: {
    requireSpaceMembership(space: string): Promise<unknown>
  },
): Promise<void> {
  const { has, flag } = flags

  if (sub === 'list') {
    listProjectsCommand(flags, presentation)
    return
  }

  if (sub === 'add') {
    await addProjectCommand(argv, flags, presentation, dependencies.requireSpaceMembership)
    return
  }

  if (sub === 'set') {
    await setProjectCommand(argv, flags, presentation)
    return
  }

  if (sub === 'select-profile') {
    const name = argv[2],
      axis = flag('axis'),
      profile = flag('name'),
      reason = flag('reason'),
      versionText = flag('version')
    if (!name || !axis || !profile || !reason?.trim())
      throw new Error(
        `${PLATFORM_SLUG} project select-profile <project> --axis A --name N [--lens ID] [--version N] --reason TEXT`,
      )
    const version = versionText === undefined ? undefined : Number(versionText)
    const result = await selectProjectProfile({
      project: name,
      axis,
      name: profile,
      lensId: flag('lens'),
      version,
      reason,
    })
    presentation.log(
      has('json')
        ? JSON.stringify(result)
        : `selected ${axis}/${profile} for ${name}${flag('lens') ? ` lens ${flag('lens')}` : ' all lenses'}`,
    )
    return
  }

  if (sub === 'migrate-create') {
    const name = argv[2]
    if (!name) throw new Error(`${PLATFORM_SLUG} project migrate-create <name> [--apply]`)
    const p = projectByName(name)
    if (!p) throw new Error(`no project "${name}"`)
    const create = p.settings.worktree?.create
    if (create === undefined && p.settings.worktree?.recipe) {
      presentation.log(`${name}: worktree.create is a recipe; nothing to migrate`)
      return
    }
    if (typeof create !== 'string') {
      presentation.log(`${name}: worktree.create is already structured; nothing to migrate`)
      return
    }
    presentation.log(`${name}: before ${JSON.stringify(create)}`)
    const migration = migrateCreate(create)
    if (migration.kind === 'refused') {
      presentation.log(`${name}: ${migration.message}`)
      return
    }
    presentation.log(`${name}: after  ${JSON.stringify(migration.after)}`)
    if (has('apply')) {
      upsertProject({
        ...p,
        settings: {
          ...p.settings,
          worktree: { ...p.settings.worktree!, create: migration.after },
        },
      })
    }
    return
  }

  if (sub === 'remove') {
    const name = argv[2]
    if (!name) throw new Error(`${PLATFORM_SLUG} project remove <name>`)
    presentation.log(
      (await removeWrittenProject(name)) ? `removed ${name}` : `no project "${name}"`,
    )
    return
  }

  if (sub === 'retire') {
    await retireProjectCommand(argv, flags, presentation)
    return
  }

  if (sub === 'push') {
    await pushProjectsCommand(has('json'), presentation)
    return
  }

  if (sub === 'fill-record-ids') {
    await fillProjectRecordIdsCommand(has('json'), presentation)
    return
  }

  throw new Error(
    `unknown: ${PLATFORM_SLUG} project ${sub}. Try list | add | set | remove | retire | push | fill-record-ids`,
  )
}
