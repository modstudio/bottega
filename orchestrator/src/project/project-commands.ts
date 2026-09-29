// concern: project-commands
/**
 * Knows project-register command semantics, validation, and presentation. Must
 * not know runs, routing, transports, reviews, the CLI, or worktrees by value.
 */
import { existsSync } from 'node:fs'
import { tryWriteContention, writeTransaction } from '../database/db.ts'
import { selectProjectProfile } from '../lens/lenses.ts'
import { lifecycleForm } from '../worktree/worktree-lifecycle.ts'
import { migrateCreate } from '../worktree/worktree-template.ts'
import {
  applyLocalProjectRename,
  assertProjectRename,
  assertRegisterBranches,
  isProjectRepository,
  type Project,
  type ProjectSettings,
  projectByName,
  projects,
  pushProjects,
  removeWrittenProject,
  retiredProjectByName,
  retireWrittenProject,
  sniffStack,
  unretireWrittenProject,
  upsertProject,
  validateProjectSettings,
  worktreeWarnings,
  writeHostedProject,
} from './projects.ts'

type ProjectFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type ProjectPresentation = { log(...values: unknown[]): void; cwd(): string }

function listedProjectJson(project: Project) {
  const { retiredAt, ...rest } = project
  return {
    ...rest,
    repository: isProjectRepository(project),
    ...(retiredAt ? { retired_at: retiredAt } : {}),
    lifecycle_form: lifecycleForm(project.settings.worktree),
    problems: validateProjectSettings(project.settings, project.path),
    commit_hooks_skipped: true,
    gate: typeof project.settings.gate === 'string' ? project.settings.gate : null,
  }
}

function emptyProjectListMessage(retired: boolean): string {
  if (retired) return 'no retired projects.'
  return (
    'no projects registered.\n\n' +
    '  orch project add <path> [--name X] [--stack Y] [--no-canon] [--json]\n' +
    '  orch project retire <name> [--undo]\n\n' +
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
    for (const problem of validateProjectSettings(p.settings, p.path)) {
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
   * `orch.db`.
   *
   * The boundary check forbids the import and a shared database would make
   * two concerns one, so what another concern needs is emitted here — the
   * same contract `orch state` already serves the dashboard under. A
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
  requireMembership: (url: string, space: string) => Promise<unknown>,
): Promise<void> {
  if (!settingsPatch || typeof settingsPatch !== 'object' || Array.isArray(settingsPatch)) return
  if (!Object.hasOwn(settingsPatch, 'space')) return
  const space = (settingsPatch as { space?: unknown }).space
  if (space === null || space === undefined) return
  if (typeof space !== 'string' || !space.trim()) return
  const url = process.env.ORCH_RECORD_URL
  if (!url) {
    throw new Error(
      `cannot validate record space ${space}: ORCH_RECORD_URL is not set; configure the record and sign in, then retry`,
    )
  }
  await requireMembership(url, space)
}

export type AddProjectInput = {
  path: string
  name: string
  stack: string | null
  canon: boolean
  settings: ProjectSettings
  allowIncomplete: boolean
}

export async function addProject(
  input: AddProjectInput,
  requireMembership: (url: string, space: string) => Promise<unknown>,
): Promise<{ project: Project; wasRetired: boolean }> {
  if (!existsSync(input.path)) throw new Error(`no such directory: ${input.path}`)
  const malformed = validateProjectSettings(input.settings, input.path, {
    validateKeyPrefixes: Object.hasOwn(input.settings, 'keyPrefixes'),
    currentProjectName: input.name,
    register: projects(),
  })
  if (malformed.length) throw new Error(malformed.join('\n'))
  await validateDeclaredSpace(input.settings, requireMembership)
  const candidate = {
    id: 0,
    name: input.name,
    path: input.path,
    stack: input.stack,
    canon: input.canon,
    retiredAt: null,
    settings: input.settings,
  }
  const incomplete = incompleteWorktreeProblems(candidate)
  if (incomplete.length && !input.allowIncomplete) throw new Error(incomplete.join('\n'))
  assertRegisterBranches(candidate)
  const wasRetired = Boolean(retiredProjectByName(input.name))
  await writeHostedProject(candidate)
  upsertProject(candidate)
  const project = projectByName(input.name)
  if (!project) throw new Error(`project ${input.name} was not registered`)
  return { project, wasRetired }
}

async function addProjectCommand(
  argv: string[],
  flags: ProjectFlags,
  presentation: ProjectPresentation,
  requireMembership: (url: string, space: string) => Promise<unknown>,
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
  const { project, wasRetired } = await addProject(
    {
      path,
      name,
      stack,
      canon: !has('no-canon'),
      settings,
      allowIncomplete: has('allow-incomplete'),
    },
    requireMembership,
  )
  if (has('json')) {
    presentation.log(JSON.stringify(project))
    return
  }
  if (wasRetired) {
    presentation.log(`un-retired ${name}`)
  } else {
    presentation.log(
      `registered ${name}  ${stack ?? '(no stack — orch project set ' + name + ' --stack ...)'}  ${path}`,
    )
  }
  for (const w of worktreeWarnings(projectByName(name)!)) {
    presentation.log(`${' '.repeat(14)} ! ${w}`)
  }
}

export type FillAbsentProjectInput = {
  name: string
  fill: { stack?: string; settings: ProjectSettings }
}

/** Atomically fills setup-owned gaps without overwriting a value written since planning. */
export async function fillAbsentProjectSettings(input: FillAbsentProjectInput): Promise<void> {
  let candidate: Project | null = null
  writeTransaction(() => {
    const current = projectByName(input.name)
    if (!current) throw new Error(`no project "${input.name}"`)
    if (input.fill.stack !== undefined && current.stack !== null) {
      throw new Error(`cannot fill stack for ${input.name}: stack is no longer absent`)
    }
    for (const key of Object.keys(input.fill.settings) as (keyof ProjectSettings)[]) {
      if (current.settings[key] !== undefined) {
        throw new Error(`cannot fill ${String(key)} for ${input.name}: field is no longer absent`)
      }
    }
    const settings = { ...current.settings, ...input.fill.settings }
    const malformed = validateProjectSettings(settings, current.path, {
      validateKeyPrefixes: Object.hasOwn(input.fill.settings, 'keyPrefixes'),
      currentProjectName: current.name,
      register: projects(),
    })
    if (malformed.length) throw new Error(malformed.join('\n'))
    const next: Project = {
      ...current,
      stack: input.fill.stack ?? current.stack,
      settings,
    }
    const incomplete = incompleteWorktreeProblems(next)
    if (incomplete.length) throw new Error(incomplete.join('\n'))
    assertRegisterBranches(next)
    upsertProject(next)
    candidate = next
  })
  if (!candidate) throw new Error(`project ${input.name} was not updated`)
  await writeHostedProject(candidate)
}

function mergeableObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function mergeProjectSettings(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key]
      continue
    }
    const previous = out[key]
    out[key] =
      mergeableObject(value) && mergeableObject(previous)
        ? mergeProjectSettings(previous, value)
        : value
  }
  return out
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

function writesKeyPrefixes(settingsJson: string | undefined): boolean {
  if (!settingsJson) return false
  try {
    const patch = JSON.parse(settingsJson)
    return Boolean(patch && typeof patch === 'object' && Object.hasOwn(patch, 'keyPrefixes'))
  } catch {
    return false
  }
}

async function persistSetProject(
  currentName: string,
  nextName: string,
  previousTrunk: string | null,
  candidate: Parameters<typeof upsertProject>[0] & { settings: { trunk?: unknown } },
): Promise<void> {
  const renamed = nextName === currentName ? null : assertProjectRename(currentName, nextName)
  await writeHostedProject({
    ...candidate,
    previousName: renamed ? currentName : undefined,
  })
  const nextTrunk = typeof candidate.settings.trunk === 'string' ? candidate.settings.trunk : null
  writeTransaction(() => {
    if (renamed) applyLocalProjectRename(renamed, currentName, nextName)
    upsertProject(candidate)
  })
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
  requireMembership: (url: string, space: string) => Promise<unknown>,
): Promise<void> {
  const name = argv[2]
  if (!name)
    throw new Error(
      'orch project set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]',
    )
  const project = projectByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  let settings = project.settings
  if (flags.flag('settings')) {
    try {
      const patch = JSON.parse(flags.flag('settings')!)
      settings = mergeProjectSettings(settings, patch) as typeof settings
      await validateDeclaredSpace(patch, requireMembership)
    } catch (error) {
      throw new Error(`--settings must be JSON: ${error}`)
    }
  }
  const nextName = flags.flag('name') ?? name
  const candidate = {
    id: project.id,
    name: nextName,
    path: flags.flag('path') ?? project.path,
    stack: flags.flag('stack') ?? project.stack,
    canon: flags.has('no-canon') ? false : flags.has('canon') ? true : project.canon,
    retiredAt: project.retiredAt,
    settings,
  }
  const malformed = validateProjectSettings(candidate.settings, candidate.path, {
    validateKeyPrefixes:
      writesKeyPrefixes(flags.flag('settings')) ||
      (nextName !== name && candidate.settings.keyPrefixes !== undefined),
    currentProjectName: name,
    projectNameAfterWrite: nextName,
    register: projects(),
  }).filter((problem) => !skipLegacyCreateMigration(project, candidate, problem))
  if (malformed.length) throw new Error(malformed.join('\n'))
  const incomplete = incompleteWorktreeProblems(candidate)
  if (incomplete.length && !flags.has('allow-incomplete')) throw new Error(incomplete.join('\n'))
  assertRegisterBranches(candidate)
  const previousTrunk = typeof project.settings.trunk === 'string' ? project.settings.trunk : null
  await persistSetProject(name, nextName, previousTrunk, candidate)
  if (flags.has('json')) {
    presentation.log(JSON.stringify(projectByName(nextName)))
    return
  }
  presentation.log(`updated ${nextName}`)
  for (const warning of worktreeWarnings(projectByName(nextName)!)) {
    presentation.log(`${' '.repeat(14)} ! ${warning}`)
  }
}

async function retireProjectCommand(
  argv: string[],
  flags: ProjectFlags,
  presentation: ProjectPresentation,
): Promise<void> {
  const name = argv[2]
  if (!name) throw new Error('orch project retire <name> [--undo]')
  if (flags.has('undo')) {
    await unretireWrittenProject(name)
    presentation.log(`un-retired ${name}`)
    return
  }
  const outcome = await retireWrittenProject(name)
  presentation.log(outcome === 'already-retired' ? `already retired ${name}` : `retired ${name}`)
}

export async function projectCommand(
  sub: string,
  argv: string[],
  flags: ProjectFlags,
  presentation: ProjectPresentation,
  dependencies: {
    requireSpaceMembership(url: string, space: string): Promise<unknown>
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
    await setProjectCommand(argv, flags, presentation, dependencies.requireSpaceMembership)
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
        'orch project select-profile <project> --axis A --name N [--lens ID] [--version N] --reason TEXT',
      )
    const version = versionText === undefined ? undefined : Number(versionText)
    const result = selectProjectProfile({
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
    if (!name) throw new Error('orch project migrate-create <name> [--apply]')
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
    if (!name) throw new Error('orch project remove <name>')
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
    const names = await pushProjects()
    if (has('json')) {
      presentation.log(JSON.stringify(names))
      return
    }
    presentation.log(`pushed ${names.length} project${names.length === 1 ? '' : 's'}`)
    return
  }

  throw new Error(`unknown: orch project ${sub}. Try list | add | set | remove | retire | push`)
}
