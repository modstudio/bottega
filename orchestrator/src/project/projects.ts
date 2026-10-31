/**
 * The projects this machine works on, as DATA rather than as code.
 *
 * Everything here used to know four repository names and one person's home
 * directory. `repoOf` matched `/Users/<someone>/Projects/<name>`; the canon
 * list was an array literal; the trackers each had their status vocabulary
 * written into a switch. None of that is wrong for one machine, and all of it
 * makes the tool unusable by anyone else — you cannot adopt a router whose
 * notion of "a project" is somebody else's filesystem.
 *
 * So a project is a row: where it lives, what it is built out of, and how its
 * tracker's vocabulary maps onto the one used here. The code knows the SHAPE of
 * a project and none of the instances.
 *
 * THE STACK IS THE INTERESTING COLUMN, and it is why this is not merely
 * tidying. Agents are not uniformly good: one may be strong on PHP and weak on
 * a Vue component, and a router keyed only on job type averages those together
 * and reports a number that is true of neither. Keying on stack lets the
 * difference show — and stack rather than project because two Laravel apps
 * share evidence where two arbitrary repos do not. Here that is immediate:
 * two Laravel apps are the same stack, so a verdict from one is real
 * evidence about the other.
 */

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  gitToplevel,
  inspectCheckout,
  inspectionGitEnv,
  resolvedPathsEqual,
  type SequenceKind,
  type SequenceState,
} from '../../../shared/git.ts'
import { githubRepository } from '../../../shared/github-repository.ts'
import { releaseTagVersion } from '../../../shared/release-tag.ts'
import { db, nowIso, writableDb } from '../database/db.ts'
import {
  DEFAULT_LOCAL_PROJECT_NAME,
  writeProjectRegisterRow,
} from '../database/project-register-store.ts'
import { loadTrackedRecipe, recipePointerErrors } from '../recipe/recipe-loader.ts'
import { classifyRunIdentifier, resolveRunIdentifier } from '../run/run-identifier.ts'
import { autonomySettingsForStorage } from '../workflow/autonomy.ts'
import {
  DEFAULT_PROJECT_CONFIG_PATH,
  resolveWorktreeLifecycle,
} from '../worktree/worktree-lifecycle.ts'
import { validateReadonlyProvision } from '../worktree/worktree-provision.ts'
import {
  CREATE_VARS,
  createHasPlaceholder,
  placeholders,
  validateCreate,
} from '../worktree/worktree-template.ts'
import { projectAgentKeyProblems } from './project-agent-keys.ts'
import { focusedTestsProblems } from './project-focused-tests.ts'
import {
  requireHostedProjectPush,
  retireProjectInHostedRecord,
  writeProjectToHostedRecord,
} from './project-hosted-write.ts'
import { type SettingsObjectMode, validateProjectInjectionSettings } from './project-injection.ts'
import {
  PROJECT_REFERENCES,
  type ProjectReferenceCounts,
  projectReferenceCounts,
} from './project-reference-counts.ts'
import type {
  MainStackConsumer,
  ProjectSettings,
  StoredProjectSettings,
  WorktreeTool,
} from './project-settings.ts'
import {
  autonomyProblems,
  canonMirrorKeyProblems,
  gateInputProblems,
  invalidOptionalStringArray,
  mainStackProblems,
  managedContextProblems,
  mcpSettingsProblems,
  projectChecksProblems,
  projectSearchProblems,
  projectSpaceProblems,
  retiredReadonlyDockerProblems,
  reviewLensProblems,
  sweepHonorsHeldProblems,
  visibilityProblems,
} from './project-settings-refusals.ts'
import {
  assertForgeVisibility,
  type ForgeVisibilityLookup,
  githubForgeVisibilityLookup,
} from './project-visibility.ts'

export type { MainStackConsumer, ProjectSettings, WorktreeTool }

export type Project = {
  /** Hosted record identity, minted locally when this install has no hosted record. */
  recordId: string
  /** What it is called. Matches the directory name by default, not necessarily. */
  name: string
  /** Absolute path to its main checkout. */
  path: string
  /**
   * What it is built out of, as a coarse label like `php-laravel-vue`.
   *
   * Deliberately coarse and deliberately shared. Its whole job is to be the
   * same string for two projects that an agent would find similar, so evidence
   * pools; a precise per-project label would be a project id with extra steps.
   */
  stack: string | null
  /** Whether work here counts toward the canon denominator in the ratio. */
  canon: boolean
  /** ISO timestamp when the row was retired; null while the project is live. */
  retiredAt: string | null
  /**
   * Per-project settings, as JSON.
   *
   * A blob rather than columns because what a project needs to declare is not
   * knowable in advance — a tracker's status vocabulary, a display color, the
   * branch its trunk is called — and every one of those added as a column would
   * be another thing the code has to know about. The shapes that ARE relied on
   * are named in `ProjectSettings`, so the reliance is at least written down.
   */
  settings: StoredProjectSettings
}

export function resolveBranchRef(value: string): {
  branch: string
  runId: string | null
} {
  if (!classifyRunIdentifier(value)) return { branch: value, runId: null }
  const recordId = resolveRunIdentifier(db(), value)
  const row = db().query('SELECT branch FROM run WHERE record_id=?').get(recordId) as {
    branch: string | null
  } | null
  if (!row) throw new Error(`no run ${value}`)
  if (!row.branch) throw new Error(`run ${value} has no branch and cannot be landed`)
  return { branch: row.branch, runId: recordId }
}

export type ReviewTipRunFact = {
  branch: string | null
  headCommit: string | null
  launchKey: string | null
}

/** Most recent same-task branch whose run tip is the reviewed commit. */
export function reviewBranchForCommit(
  commit: string,
  launchKey: string | null | undefined,
  runsNewestFirst: readonly ReviewTipRunFact[],
): string | null {
  const task = launchKey?.trim().toUpperCase()
  if (!task) return null
  return (
    runsNewestFirst.find(
      (run) =>
        run.branch && run.headCommit === commit && run.launchKey?.trim().toUpperCase() === task,
    )?.branch ?? null
  )
}

/** Adapt recorded same-project run tips into the pure review-target branch decision. */
export function recordedReviewBranch(
  projectRecordId: string,
  commit: string,
  launchKey: string | null | undefined,
  database: Database = db(),
): string | null {
  const task = launchKey?.trim().toUpperCase()
  if (!task) return null
  const facts = database
    .query<ReviewTipRunFact, [string, string, string]>(
      `SELECT branch,head_commit AS headCommit,launch_key AS launchKey FROM run
        WHERE project_record_id=? AND head_commit=? AND branch IS NOT NULL
          AND upper(trim(launch_key))=?
        ORDER BY number DESC LIMIT 1`,
    )
    .all(projectRecordId, commit, task)
  return reviewBranchForCommit(commit, launchKey, facts)
}

/** Whether recorded facts prove that an absent tree has run-owned teardown. */
export function absentTreeTeardownPlan(input: {
  recipeSnapshot: string | null
  worktreeSource: 'recipe' | 'git' | 'clone' | 'readonly_recipe' | null | undefined
  resourceTeardown: 'pending' | 'done' | null | undefined
  registeredRemoveCommand: boolean
}): boolean {
  return (
    input.resourceTeardown === 'pending' &&
    (Boolean(input.recipeSnapshot) ||
      (input.worktreeSource === 'recipe' && input.registeredRemoveCommand))
  )
}

/** Apply the repository-local default without persisting derived config into the register. */
export function resolvedWorktreeTool(
  project: Pick<Project, 'path' | 'settings'> | null | undefined,
  fileExists: (path: string) => boolean = existsSync,
): WorktreeTool | null {
  if (!project) return null
  const declared = project.settings.worktree
  let resolution = resolveWorktreeLifecycle(declared)
  if (resolution.form === 'none') {
    resolution = resolveWorktreeLifecycle(
      declared,
      fileExists(resolve(project.path, DEFAULT_PROJECT_CONFIG_PATH)),
    )
  }
  if (resolution.form === 'tracked-recipe' && resolution.source === 'default') {
    return { ...declared, recipePath: resolution.recipePath }
  }
  return declared ?? null
}

function parse(row: {
  record_id: string
  name: string
  path: string
  stack: string | null
  canon: number
  settings: string | null
  retired_at?: string | null
}): Project {
  let settings: StoredProjectSettings = {}
  try {
    settings = row.settings ? JSON.parse(row.settings) : {}
  } catch {
    // Unreadable settings must not take the project out of the register: a
    // typo in one JSON blob would otherwise make a whole repo invisible to
    // routing and reporting at once.
    settings = {}
  }
  return {
    recordId: row.record_id,
    name: row.name,
    path: row.path,
    stack: row.stack,
    canon: row.canon === 1,
    retiredAt: row.retired_at ?? null,
    settings,
  }
}

export function projects(opts?: { retired?: boolean }, database: Database = db()): Project[] {
  const sql = opts?.retired
    ? 'SELECT * FROM project WHERE retired_at IS NOT NULL ORDER BY name'
    : 'SELECT * FROM project WHERE retired_at IS NULL ORDER BY name'
  return (database.query(sql).all() as Parameters<typeof parse>[0][]).map(parse)
}

export function projectRowByName(name: string, d = db()): Project | null {
  const r = d.query('SELECT * FROM project WHERE name = ?').get(name) as
    | Parameters<typeof parse>[0]
    | null
  return r ? parse(r) : null
}

export function projectByName(name: string, d = db()): Project | null {
  const project = projectRowByName(name, d)
  return project?.retiredAt ? null : project
}

export function retiredProjectByName(name: string): Project | null {
  const project = projectRowByName(name)
  return project?.retiredAt ? project : null
}

/** Dispatching into a retired project names the undo, not emptiness. */
export function retiredProjectRefusal(name: string): string {
  return `project ${name} is retired; cleared by: ${PLATFORM_SLUG} project retire ${name} --undo`
}

export function retiredProjectAt(cwd: string): Project | null {
  let best: Project | null = null
  for (const p of projects({ retired: true })) {
    if (!isProjectRepository(p)) continue
    if (cwd === p.path || cwd.startsWith(`${p.path}/`)) {
      if (!best || p.path.length > best.path.length) best = p
    }
  }
  return best
}

/**
 * Which project a directory belongs to.
 *
 * LONGEST PATH WINS, which is what makes worktrees work. A worktree lives at
 * `<repo>/.claude/worktrees/orch-123`, so it is inside its project's path and
 * resolves correctly with no special case — and if one project were ever nested
 * inside another, the inner one is the right answer.
 *
 * Returns null for anywhere unregistered rather than guessing from the path
 * shape. Guessing is what the old `/Users/<someone>/Projects/<name>` regex did,
 * and its failure mode was silent: an unrecognized layout produced `null` that
 * read as "no project" rather than as "this tool has never been told about your
 * machine".
 */
export function projectAmong(cwd: string, candidates: Iterable<Project>): Project | null {
  let best: Project | null = null
  for (const p of candidates) {
    if (!isProjectRepository(p)) continue
    if (cwd === p.path || cwd.startsWith(`${p.path}/`)) {
      if (!best || p.path.length > best.path.length) best = p
    }
  }
  return best
}

export function projectAt(cwd: string, database: Database = db()): Project | null {
  return projectAmong(cwd, projects(undefined, database))
}

/** Whether a registered project path is a repository that repository consumers may enter. */
export function isProjectRepository(project: Pick<Project, 'path'>): boolean {
  return gitToplevel(project.path) !== null
}

export function projectRepositoryRefusal(project: Pick<Project, 'name' | 'path'>): string | null {
  return isProjectRepository(project)
    ? null
    : `project ${project.name} has no repository: ${project.path} is not a git checkout`
}

/** The stack a directory's work is in, for routing. */
export function stackAt(cwd: string): string | null {
  return projectAt(cwd)?.stack ?? null
}

export function upsertProject(p: {
  recordId: string
  name: string
  path: string
  stack?: string | null
  canon?: boolean
  settings?: ProjectSettings
}): void {
  const database = writableDb()
  writeProjectRegisterRow(database, {
    ...p,
    settings: projectSettingsForStorage(p.settings),
  })
}

/** Store the hosted identity once on the exact snapshotted row. */
export function storeProjectRecordId(
  name: string,
  recordId: string,
  database: Database = writableDb(),
): void {
  const result = database
    .query('UPDATE project SET record_id=? WHERE name=? AND record_id IS NULL')
    .run(recordId, name)
  if (result.changes > 0) return
  const project = database.query('SELECT name,record_id FROM project WHERE name=?').get(name) as {
    name: string
    record_id: string | null
  } | null
  if (!project) {
    throw new Error(
      `project ${name} was removed while its hosted identity was being stored; inspect \`${PLATFORM_SLUG} project list --json\` and the hosted project before retrying`,
    )
  }
  if (project.record_id !== recordId) {
    throw new Error(
      `project ${project.name} already has hosted identity ${project.record_id}; inspect \`${PLATFORM_SLUG} project list --json\` and the hosted project before retrying`,
    )
  }
}

function projectSettingsForStorage(
  settings: ProjectSettings | undefined,
): StoredProjectSettings | undefined {
  if (!settings?.autonomy) return settings
  return {
    ...settings,
    autonomy: autonomySettingsForStorage(settings.autonomy),
  }
}

export async function writeHostedProject(
  p: {
    recordId?: string | null
    name: string
    path: string
    stack?: string | null
    canon?: boolean
    settings?: ProjectSettings
    retiredAt?: string | null
  },
  destinationSpaceId?: string,
): Promise<string> {
  return writeProjectToHostedRecord(
    { ...p, settings: projectSettingsForStorage(p.settings) },
    destinationSpaceId,
  )
}

export async function pushProjects(): Promise<string[]> {
  requireHostedProjectPush()
  const names: string[] = []
  for (const project of [...projects(), ...projects({ retired: true })]) {
    const recordId = await writeHostedProject({
      recordId: project.recordId,
      name: project.name,
      path: project.path,
      stack: project.stack,
      canon: project.canon,
      settings: project.settings,
      retiredAt: project.retiredAt,
    })
    if (project.recordId !== recordId)
      throw new Error(`hosted project identity changed for ${project.name}`)
    names.push(project.name)
  }
  return names
}

/** Change only the hosted-record destination read by sync. */
export function setProjectRecordSpace(name: string, space: string): void {
  const project = projectByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  const settings = { ...project.settings, space }
  // The row keeps every key it already held; the write only judges the space it was given.
  const malformed = validateStoredProjectSettings(settings, project.path)
  if (malformed.length) throw new Error(malformed.join('\n'))
  writableDb()
  db()
    .query('UPDATE project SET settings=? WHERE record_id=?')
    .run(JSON.stringify(projectSettingsForStorage(settings)), project.recordId)
}

/** Local rename preconditions: existence, a non-empty target, and a free name. */
export function assertProjectRename(currentName: string, nextName: string): { recordId: string } {
  if (!nextName.trim()) throw new Error('project --name must be non-empty')
  const current = projectByName(currentName)
  if (!current) throw new Error(`no project "${currentName}"`)
  if (currentName !== nextName && projectByName(nextName))
    throw new Error(`project "${nextName}" already exists`)
  return { recordId: current.recordId }
}

export type { ProjectReferenceCounts } from './project-reference-counts.ts'

/** Two anchored lines, or null when the row may be deleted. */
export function projectRemovalRefusal(
  name: string,
  counts: ProjectReferenceCounts,
): string[] | null {
  const named = PROJECT_REFERENCES.filter(([key]) => counts[key] > 0).map(
    ([key, label]) => `${counts[key]} ${label}(s)`,
  )
  if (!named.length) return null
  return [
    `project ${name} is referenced by ${named.join(', ')}; removing it would blank their project attribution`,
    `cleared by: ${PLATFORM_SLUG} project retire ${name}`,
  ]
}

export function removeProject(name: string): boolean {
  writableDb()
  const project = projectByName(name)
  if (!project) return false
  const refusal = projectRemovalRefusal(name, projectReferenceCounts(db(), project.recordId))
  if (refusal) throw new Error(refusal.join('\n'))
  return db().query('DELETE FROM project WHERE record_id = ?').run(project.recordId).changes > 0
}

export async function removeWrittenProject(name: string): Promise<boolean> {
  const project = projectByName(name)
  if (!project) return false
  const refusal = projectRemovalRefusal(name, projectReferenceCounts(db(), project.recordId))
  if (refusal) throw new Error(refusal.join('\n'))
  await retireProjectInHostedRecord(project, project.settings)
  return removeProject(name)
}

export function retireProject(name: string): 'retired' | 'already-retired' {
  writableDb()
  const project = projectRowByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  if (project.retiredAt) return 'already-retired'
  db().query('UPDATE project SET retired_at=? WHERE record_id=?').run(nowIso(), project.recordId)
  return 'retired'
}

export async function retireWrittenProject(name: string): Promise<'retired' | 'already-retired'> {
  const project = projectRowByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  await retireProjectInHostedRecord(project, project.settings)
  return retireProject(name)
}

export function unretireProject(name: string): boolean {
  writableDb()
  const project = projectRowByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  if (!project.retiredAt) return false
  db().query('UPDATE project SET retired_at=NULL WHERE record_id=?').run(project.recordId)
  return true
}

export async function unretireWrittenProject(name: string): Promise<boolean> {
  const project = projectRowByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  await writeHostedProject({
    recordId: project.recordId,
    name: project.name,
    path: project.path,
    stack: project.stack,
    canon: project.canon,
    settings: project.settings,
    retiredAt: null,
  })
  return unretireProject(name)
}

type ProjectSettingsValidationContext = {
  validateKeyPrefixes?: boolean
  currentProjectName?: string
  projectNameAfterWrite?: string
  register?: Pick<Project, 'name' | 'settings'>[]
  enabledLensIds?: readonly string[]
  enabledLensSpaceId?: string | null
}

function keyPrefixProblems(value: unknown, context: ProjectSettingsValidationContext): string[] {
  if (!context.validateKeyPrefixes) return []
  if (!Array.isArray(value) || value.length === 0) {
    return ['keyPrefixes must be a non-empty array of plain prefixes']
  }
  const problems: string[] = []
  const seen = new Set<string>()
  const occupied = new Set(
    (context.register ?? [])
      .filter((project) => project.name !== context.currentProjectName)
      .flatMap((project) => project.settings.keyPrefixes ?? []),
  )
  for (const prefix of value) {
    if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(prefix)) {
      problems.push(
        'keyPrefixes must contain only plain prefixes (A-Z and digits, starting with a letter)',
      )
      continue
    }
    if (
      prefix === 'TASK' &&
      (context.projectNameAfterWrite ?? context.currentProjectName) !== DEFAULT_LOCAL_PROJECT_NAME
    ) {
      problems.push('key prefix TASK is reserved')
    }
    if (seen.has(prefix)) problems.push(`key prefix ${prefix} is repeated`)
    if (occupied.has(prefix))
      problems.push(`key prefix ${prefix} is already used by another project`)
    seen.add(prefix)
  }
  return problems
}

function workerCheckProblems(value: unknown): string[] {
  if (value === undefined || (typeof value === 'string' && value.trim())) return []
  return ['workerCheck must be a non-empty string']
}

export function validateProjectSettings(
  settings: ProjectSettings,
  mode: SettingsObjectMode,
  projectPath?: string,
  context: ProjectSettingsValidationContext = {},
): string[] {
  const problems = [
    ...validateProjectInjectionSettings(settings, mode),
    ...validateCreate(settings.worktree?.create as unknown, 'worktree.create', CREATE_VARS),
    ...validateCreate(
      settings.worktree?.readonly_create as unknown,
      'worktree.readonly_create',
      new Set(['path', 'base']),
    ),
    ...validateReadonlyProvision(settings.worktree?.readonly_provision),
    ...retiredReadonlyDockerProblems(settings.worktree),
    ...sweepHonorsHeldProblems(settings.worktree),
    ...trackedRecipeProblems(settings.worktree, projectPath),
    ...projectSpaceProblems(settings.space),
    ...autonomyProblems(settings.autonomy),
    ...projectChecksProblems(settings.checks, mode),
    ...managedContextProblems(settings.managedContext),
    ...canonMirrorKeyProblems(settings.canonMirrorKey),
    ...projectSearchProblems(settings.search, mode),
    ...keyPrefixProblems(settings.keyPrefixes, context),
    ...mainStackProblems(settings.mainStack, mode),
    ...reviewLensProblems(settings.review, context.enabledLensIds, context.enabledLensSpaceId),
    ...mcpSettingsProblems(settings.mcp),
    ...visibilityProblems(settings.visibility),
    ...focusedTestsProblems(settings.focusedTests),
    ...gateInputProblems(settings.gateInput),
    ...workerCheckProblems(settings.workerCheck),
    ...projectAgentKeyProblems(settings.agentKeys),
  ]

  if (invalidOptionalStringArray(settings.secretPaths)) {
    problems.push('secretPaths must be an array of non-empty path strings')
  }
  if (invalidOptionalStringArray(settings.workerMcpServers))
    problems.push('workerMcpServers must be an array of non-empty strings')
  if (settings.requireCleanMain !== undefined && typeof settings.requireCleanMain !== 'boolean') {
    problems.push('requireCleanMain must be a boolean')
  }
  if (
    settings.mcpServer !== undefined &&
    (typeof settings.mcpServer !== 'string' || !settings.mcpServer.trim())
  ) {
    problems.push('mcpServer must be a non-empty string')
  }
  const readonly = settings.worktree?.readonly_create
  if (readonly && !createHasPlaceholder(readonly, 'path')) {
    problems.push('worktree.readonly_create must contain {path}')
  }
  if (readonly && !createHasPlaceholder(readonly, 'base')) {
    problems.push('worktree.readonly_create must contain {base}')
  }
  const readonlyRemove = settings.worktree?.readonly_remove
  if (readonlyRemove !== undefined) {
    if (typeof readonlyRemove !== 'string' || !readonlyRemove.trim()) {
      problems.push('worktree.readonly_remove must be a non-empty template')
    } else {
      const unknown = placeholders(readonlyRemove).find((name) => name !== 'path')
      if (unknown)
        problems.push(`worktree.readonly_remove contains unknown placeholder {${unknown}}`)
      if (!placeholders(readonlyRemove).includes('path')) {
        problems.push('worktree.readonly_remove must contain {path}')
      }
    }
  }
  return problems
}

function trackedRecipeProblems(worktree: WorktreeTool | undefined, projectPath?: string): string[] {
  const problems: string[] = []
  if (worktree?.recipePath !== undefined && typeof worktree.recipePath !== 'string') {
    problems.push('recipe path rule: worktree.recipePath must be a string')
    return problems
  }
  let resolution = resolveWorktreeLifecycle(worktree)
  if (resolution.form === 'none' && projectPath) {
    resolution = resolveWorktreeLifecycle(
      worktree,
      existsSync(resolve(projectPath, DEFAULT_PROJECT_CONFIG_PATH)),
    )
  }
  if (resolution.form === 'tracked-recipe') {
    const pointerProblems = recipePointerErrors(resolution.recipePath).map(
      (problem) => `worktree.recipePath: ${problem}`,
    )
    problems.push(...pointerProblems)
    if (!pointerProblems.length && projectPath) {
      const loaded = loadTrackedRecipe(projectPath, resolution.recipePath)
      if (!loaded.ok) problems.push(...loaded.errors)
    }
  }
  return problems
}

/**
 * Validate a stored row without re-refusing its unchanged legacy create string.
 *
 * A stored row is ALWAYS read in strip mode, whatever the caller is about to
 * write: the register is written by one binary and read by another, so a key a
 * newer binary wrote is the ordinary case and refusing it here takes the whole
 * project, and every workflow that needs it, out of the register at once.
 */
export function validateStoredProjectSettings(
  settings: ProjectSettings,
  projectPath?: string,
): string[] {
  const legacy = 'worktree.create is a shell string; migrate it (DEV-308)'
  return validateProjectSettings(settings, 'strip', projectPath).filter(
    (problem) => !(typeof settings.worktree?.create === 'string' && problem === legacy),
  )
}

/**
 * The keys a register write must still refuse out of what its caller supplied.
 *
 * Every other issue is judged on the row the write produces, because a patch is
 * partial and the stored row completes it: `--settings '{"tracker":{"reviewStages":…}}'`
 * is a complete tracker once merged, and refusing it for the keys it did not
 * mention would refuse the remedy every refusal message prints. Only a key this
 * binary does not know is settled by the supplied object alone, and strip mode
 * reports everything strict mode reports except those, so the difference between
 * the two modes over the same supplied object is exactly them — over the whole
 * settings grammar, which is why this lives beside it rather than in the
 * injection module that owns only part of it.
 */
export function suppliedUnknownKeyProblems(supplied: Record<string, unknown>): string[] {
  const settings = supplied as ProjectSettings
  const dropped = new Set(validateProjectSettings(settings, 'strip'))
  return validateProjectSettings(settings, 'strict').filter((problem) => !dropped.has(problem))
}

/**
 * The problems one register write must refuse: the row it produces, read in
 * strip mode so a key a newer binary wrote survives the update, plus the keys
 * its caller supplied, which only strict mode settles. Both update commands
 * ask this, so the split between the two modes is decided in one place.
 */
export function validateRegisterWrite(input: {
  merged: ProjectSettings
  supplied?: Record<string, unknown>
  projectPath?: string
  context?: ProjectSettingsValidationContext
}): string[] {
  return [
    ...new Set([
      ...validateProjectSettings(input.merged, 'strip', input.projectPath, input.context),
      ...(input.supplied ? suppliedUnknownKeyProblems(input.supplied) : []),
    ]),
  ]
}

export type RegisterBranchCheck = {
  head: string | null
  landing: string | null
  canonIntegration: string | null
  problems: string[]
}

/** Choose the detached-checkout message from facts already gathered by the git adapter. */
export function detachedCheckoutDecision(
  landing: string | null,
  detached: boolean,
  tagsAtHead: readonly string[],
  checkoutPath: string,
  projectName: string,
): string | null {
  if (!landing || !detached) return null
  const releaseTag = [...tagsAtHead].sort().find((tag) => releaseTagVersion(tag) !== null)
  return releaseTag
    ? `release tag ${releaseTag} is checked out; a development checkout stays on its landing branch ${landing}\n` +
        `cleared by: git -C ${shellQuote(checkoutPath)} switch -- ${shellQuote(landing)}`
    : `checkout HEAD is detached, not landing branch ${landing}\n` +
        registerBranchRemedy(landing, checkoutPath, projectName)
}

function registerBranchRemedy(landing: string, checkoutPath: string, projectName: string): string {
  return (
    `cleared by: check out ${landing} in ${checkoutPath} or correct it with ${PLATFORM_SLUG} project set ${projectName} ` +
    `--settings '{"trunk":"<branch>"}'`
  )
}

/** Verify branch facts at registration time; never guess a detached HEAD. */
export function registerBranchCheck(
  project: Pick<Project, 'name' | 'path' | 'settings'>,
): RegisterBranchCheck {
  const landing =
    typeof project.settings.trunk === 'string' && project.settings.trunk.trim()
      ? project.settings.trunk.trim()
      : null
  const headResult = Bun.spawnSync(
    ['git', '-C', project.path, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    {
      env: inspectionGitEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    },
  )
  const head = headResult.exitCode === 0 ? headResult.stdout.toString().trim() || null : null
  const tagResult =
    headResult.exitCode === 1
      ? Bun.spawnSync(['git', '-C', project.path, 'tag', '--points-at', 'HEAD'], {
          env: inspectionGitEnv(),
          stdout: 'pipe',
          stderr: 'ignore',
        })
      : null
  const tagsAtHead =
    tagResult?.exitCode === 0 ? tagResult.stdout.toString().trim().split('\n').filter(Boolean) : []
  const detachedDecision = detachedCheckoutDecision(
    landing,
    head === null,
    tagsAtHead,
    project.path,
    project.name,
  )
  let canonIntegration: string | null = null
  const canonPath = join(project.path, 'AGENTS.md')
  if (existsSync(canonPath)) {
    const canon = readFileSync(canonPath, 'utf8')
    const match = canon.match(
      /\bintegration branch\s+(?:is|:)\s*[`'"]?([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?)/i,
    )
    canonIntegration = match?.[1] ?? null
  }
  const problems: string[] = []
  if (landing && head !== landing) {
    problems.push(
      detachedDecision ??
        `checkout HEAD is ${head ?? 'detached'}, not landing branch ${landing}\n${registerBranchRemedy(landing, project.path, project.name)}`,
    )
  }
  if (landing && canonIntegration && canonIntegration !== landing) {
    problems.push(
      `canon names integration branch ${canonIntegration}, not landing branch ${landing}`,
    )
  }
  const production =
    typeof project.settings.productionBranch === 'string'
      ? project.settings.productionBranch.trim()
      : ''
  if (landing && production && production === landing) {
    problems.push(`production branch ${production} must be distinct from landing branch ${landing}`)
  }
  return {
    head,
    landing,
    canonIntegration,
    problems,
  }
}

export function assertRegisterBranches(
  project: Pick<Project, 'name' | 'path' | 'settings'>,
  check: RegisterBranchCheck = registerBranchCheck(project),
): void {
  if (!check.problems.length) return
  throw new Error(
    `${project.name}: ${check.problems.join('; ')}\n` +
      'invariant: the register landing branch agrees with the main checkout and its integration-branch canon',
  )
}

export function assertRegisterVisibility(
  project: Pick<Project, 'name' | 'path' | 'settings'>,
  lookup: ForgeVisibilityLookup = githubForgeVisibilityLookup,
): string | null {
  const declared = project.settings.visibility
  if (!declared) return null
  const repository = currentProjectRepository(project)
  if (!repository) {
    throw new Error(
      `${project.name}: could not resolve a GitHub owner/name from origin\n` +
        'cleared by: configure a GitHub origin, or leave repository visibility undeclared',
    )
  }
  assertForgeVisibility({ project: project.name, repository, declared, lookup })
  return repository
}

/** Current canonical GitHub owner/name read only from the registered checkout's origin. */
export function currentProjectRepository(project: Pick<Project, 'path'>): string | null {
  const origin = Bun.spawnSync(['git', '-C', project.path, 'remote', 'get-url', 'origin'], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return origin.exitCode === 0 ? githubRepository(origin.stdout.toString()) : null
}

const MAIN_CHECKOUT_INVARIANT = 'A registered main checkout stays clean; work happens in a worktree'

/** Default ON. Only an explicit false is an exemption. */
function requiresCleanMain(settings: ProjectSettings): boolean {
  return settings.requireCleanMain !== false
}

function mainCheckoutWorktreeHint(projectPath: string): string {
  return join(projectPath, '.claude', 'worktrees')
}

type MainCheckoutInspection = {
  dirtyTracked: string[]
  untracked: string[]
  sequence: SequenceState
}

/**
 * Cleanliness of one main checkout.
 *
 * Encoded, not inferred:
 * - tracked modifications block
 * - an in-progress sequence blocks (merge / cherry-pick / rebase / revert /
 *   am / bisect); residue of a pseudo-ref over a clean tree does not —
 *   refusing residue would incorrectly block an otherwise clean tree
 * - untracked files warn and do not block (orchestrator.db and build output live there)
 * - ignored files are silent
 * - submodules: `--ignore-submodules=untracked`, so a dirty gitlink or tracked
 *   change inside a submodule still blocks, and untracked files inside a
 *   submodule are not this checkout's untracked set
 *
 * Dirty check is `git --no-optional-locks status --porcelain=v1`. It does
 * not write the index. Unrunnable git is
 * INDETERMINATE: this returns null and the caller fails open. A false
 * refusal on a clean tree is worse than a missed dirty one.
 *
 * The registered path must be the git toplevel; a subdirectory is not a main
 * checkout and is left alone.
 */
function inspectMainCheckout(projectPath: string): MainCheckoutInspection | null {
  const toplevel = gitToplevel(projectPath)
  if (!toplevel || !resolvedPathsEqual(projectPath, toplevel)) return null
  const state = inspectCheckout(projectPath)
  if (state.cleanliness === 'indeterminate') return null
  return {
    dirtyTracked: state.dirtyTracked,
    untracked: state.untracked,
    sequence: state.sequence,
  }
}

/** POSIX single-quote so a cleared-by line can be pasted into a shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function mainCheckoutRefusal(
  project: Pick<Project, 'name' | 'path'>,
  dirtyTracked: string[],
): string {
  const hint = mainCheckoutWorktreeHint(project.path)
  return (
    `${project.name}: main checkout ${project.path} has tracked modifications: ${dirtyTracked.join(', ')}\n` +
    `work from a worktree under ${hint} instead\n` +
    `invariant: ${MAIN_CHECKOUT_INVARIANT}\n` +
    `cleared by: ${PLATFORM_SLUG} run start --cwd ${shellQuote(`${hint}/<tree>`)}`
  )
}

function sequenceClearCommand(kind: SequenceKind, path: string): string {
  const quoted = shellQuote(path)
  if (kind === 'bisect') return `git -C ${quoted} bisect reset`
  if (kind === 'am') return `git -C ${quoted} am --abort`
  return `git -C ${quoted} ${kind} --abort`
}

function mainCheckoutSequenceRefusal(
  project: Pick<Project, 'name' | 'path'>,
  kind: SequenceKind,
): string {
  const hint = mainCheckoutWorktreeHint(project.path)
  if (kind === 'cherry-pick') {
    return (
      `${project.name}: main checkout ${project.path} has cherry-pick state; git status cannot distinguish ` +
      `a live empty cherry-pick from a leftover CHERRY_PICK_HEAD\n` +
      `work from a worktree under ${hint} instead\n` +
      `invariant: ${MAIN_CHECKOUT_INVARIANT}\n` +
      `inspect with: git -C ${shellQuote(project.path)} status`
    )
  }
  return (
    `${project.name}: main checkout ${project.path} has an in-progress ${kind}\n` +
    `work from a worktree under ${hint} instead\n` +
    `invariant: ${MAIN_CHECKOUT_INVARIANT}\n` +
    `cleared by: ${sequenceClearCommand(kind, project.path)}`
  )
}

/** Throws on tracked dirt or an in-progress sequence. Returns an untracked warning, or null when silent. */
export function assertMainCheckoutClean(
  project: Pick<Project, 'name' | 'path' | 'settings'>,
): string | null {
  if (!requiresCleanMain(project.settings)) return null
  const inspection = inspectMainCheckout(project.path)
  if (!inspection) return null
  if (inspection.sequence.status === 'in-progress') {
    throw new Error(mainCheckoutSequenceRefusal(project, inspection.sequence.kind))
  }
  if (inspection.dirtyTracked.length) {
    throw new Error(mainCheckoutRefusal(project, inspection.dirtyTracked))
  }
  if (!inspection.untracked.length) return null
  const hint = mainCheckoutWorktreeHint(project.path)
  return (
    `! ${project.name}: main checkout ${project.path} has untracked files: ${inspection.untracked.join(', ')}\n` +
    `  they do not block dispatch; work from a worktree under ${hint}`
  )
}

function configuredHooksPath(projectPath: string): string | null {
  if (existsSync(join(projectPath, '.githooks'))) return join(projectPath, '.githooks')
  const configured = Bun.spawnSync(
    ['git', '-C', projectPath, 'config', '--path', 'core.hooksPath'],
    {
      env: inspectionGitEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    },
  )
  if (configured.exitCode === 0) {
    const value = configured.stdout.toString().trim()
    if (value) return value.startsWith('/') ? value : resolve(projectPath, value)
  }
  const gitHooks = join(projectPath, '.git', 'hooks')
  return existsSync(gitHooks) ? gitHooks : null
}

/** Doctor: a gate that declares nothing while the hooks directory carries pre-commit checks. */
export function undeclaredCommitHooks(project: Project): string | null {
  if (typeof project.settings.gate === 'string' && project.settings.gate.trim()) return null
  const hooks = configuredHooksPath(project.path)
  if (!hooks) return null
  const checks = ['pre-commit', 'commit-msg', 'pre-push'].filter((name) =>
    existsSync(join(hooks, name)),
  )
  if (!checks.length) return null
  return `${project.name}: gate undeclared while hooks carry pre-commit checks (${checks.join(', ')} in ${hooks})`
}

/**
 * Guess a stack by looking at what a checkout contains.
 *
 * Only ever used to SUGGEST a value when registering, never to decide one at
 * routing time. A guess that runs on every routing decision is a guess nobody
 * ever reviews; a guess offered once, at the moment a person is registering the
 * project and looking straight at it, is a convenience they can correct.
 */
export function sniffStack(path: string): string | null {
  const has = (f: string) => existsSync(join(path, f))
  const read = (f: string) => {
    try {
      return readFileSync(join(path, f), 'utf8')
    } catch {
      return ''
    }
  }
  const parts: string[] = []
  if (has('composer.json')) parts.push('php')
  if (has('artisan')) parts.push('laravel')
  const pkg = has('package.json') ? read('package.json') : ''
  if (pkg && !parts.length) parts.push('node')
  for (const [dep, label] of [
    ['"vue"', 'vue'],
    ['"react"', 'react'],
    ['"next"', 'next'],
    ['"svelte"', 'svelte'],
    ['drizzle', 'drizzle'],
  ] as const) {
    if (pkg.includes(dep)) parts.push(label)
  }
  if (has('go.mod')) parts.push('go')
  if (has('Cargo.toml')) parts.push('rust')
  if (has('pyproject.toml') || has('requirements.txt')) parts.push('python')
  return parts.length ? parts.join('-') : null
}

/**
 * Ways a project's worktree settings contradict themselves.
 *
 * A settings write used to merge only one level deep, so updating
 * `worktree.notes` replaced the whole `worktree` object and silently discarded
 * its create, remove, sweep and branch template. One project spent hours in that
 * state — a `create` command with no branch template, so every run was handed
 * `orch/<id>`, which its own script correctly refuses. The merge is deep now
 * and cannot do that again, but nothing would have NOTICED, and the state is
 * cheap to recognize: a tool that can make a worktree and not remove one is
 * incoherent however it got that way.
 *
 * Reported, never enforced. A half-configured project should say so and keep
 * working, not refuse to run.
 */
export function worktreeWarnings(p: Project): string[] {
  const w = p.settings.worktree
  if (!w) return []
  const resolved = resolveWorktreeLifecycle(
    w,
    existsSync(resolve(p.path, DEFAULT_PROJECT_CONFIG_PATH)),
  )
  const out: string[] = []
  if (w.create && !w.remove) {
    out.push('has a create command but no remove: orchestrator cannot tear down what it makes')
  }
  if (w.create && w.recipe) {
    out.push('declares both create and recipe; create wins and the recipe is ignored')
  }
  if (resolved.form === 'none') {
    out.push(
      `declares no worktree lifecycle and has no ${DEFAULT_PROJECT_CONFIG_PATH}, so it cannot make a worktree at all`,
    )
  }
  /*
   * Only for a project running its OWN script.
   *
   * That script may enforce a branch format, and orchestrator's default `orch/<id>` is
   * what it then refuses — which is how this was found, twice. A recipe project
   * has no such script: orchestrator names the branch itself, so the default is correct
   * and warning about it would be noise on the one project that cannot have the
   * problem.
   */
  if (w.create && !w.branch) {
    out.push(
      'has a create command but no branch template, so runs get orch/<id> - ' +
        'which a project enforcing a branch format will reject',
    )
  }
  if (createHasPlaceholder(w.create, 'seed') && !w.seeds?.length) {
    out.push(
      'has a create command with a {seed} placeholder but no seeds list, so orchestrator cannot ' +
        'say which values are valid',
    )
  }
  return out
}
