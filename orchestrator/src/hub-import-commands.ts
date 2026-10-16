// concern: hub-import-command
/** Resolves registered Bottega checkouts and judges proposed hub edits with installed policy. */

import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { openReadOnlyDatabase } from './database/db.ts'
import { type Project, projectAt } from './project/projects.ts'

type ToolPayload = {
  tool_name?: unknown
  tool_input?: unknown
  cwd?: unknown
}

type HubImportJudgment = {
  status: 'ok' | 'refused' | 'unchecked'
  findings: { rule: string; dependency: string }[]
  reason?: string
}

type RegisteredProject = Pick<Project, 'name' | 'path'>

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function within(root: string, path: string) {
  const value = relative(root, path)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

/** Pure applicability decision after the project register has resolved the owning project. */
export function registeredHubCheckout(
  file: string,
  project: RegisteredProject | null,
): string | null {
  if (!project || project.name !== PLATFORM_SLUG || !within(project.path, file)) return null
  const projectRelative = relative(project.path, file).split(sep)
  const checkout =
    projectRelative[0] === '.claude' && projectRelative[1] === 'worktrees' && projectRelative[2]
      ? join(project.path, ...projectRelative.slice(0, 3))
      : project.path
  const checkoutRelative = relative(checkout, file).split(sep).join('/')
  return checkoutRelative.startsWith('hub/') ? checkout : null
}

function registeredCheckout(file: string, database: Database): string | null {
  return registeredHubCheckout(file, projectAt(file, database))
}

function replacement(source: string, edit: Record<string, unknown>) {
  const oldString = edit.old_string
  const newString = edit.new_string
  if (
    typeof oldString !== 'string' ||
    typeof newString !== 'string' ||
    !source.includes(oldString)
  ) {
    throw new Error('edit strings do not describe the current file')
  }
  return edit.replace_all === true
    ? source.split(oldString).join(newString)
    : source.replace(oldString, newString)
}

function proposedContent(file: string, payload: ToolPayload) {
  const input = object(payload.tool_input)
  if (!input) throw new Error('tool input is not an object')
  if (payload.tool_name === 'Write') {
    if (typeof input.content !== 'string') throw new Error('Write has no content')
    return input.content
  }
  let content = readFileSync(file, 'utf8')
  if (payload.tool_name === 'Edit') return replacement(content, input)
  if (payload.tool_name !== 'MultiEdit' || !Array.isArray(input.edits)) {
    throw new Error('tool input is not a supported editor shape')
  }
  for (const edit of input.edits) {
    const value = object(edit)
    if (!value) throw new Error('MultiEdit contains an invalid edit')
    content = replacement(content, value)
  }
  return content
}

function targetFile(payload: ToolPayload) {
  const input = object(payload.tool_input)
  const raw = input?.file_path ?? input?.path
  if (typeof raw !== 'string' || raw.length === 0) return null
  return resolve(typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), raw)
}

async function runInstalledJudge(
  judge: string,
  args: string[],
  installedRoot: string,
): Promise<HubImportJudgment> {
  const child = Bun.spawn([process.execPath, '--no-env-file', judge, ...args], {
    cwd: installedRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `judge failed (${stderr.trim().replaceAll('\n', ' ') || `exit ${exitCode}`})`,
    }
  }
  return JSON.parse(stdout) as HubImportJudgment
}

function createCandidateDirectories(directory: string, created: string[]) {
  const missing: string[] = []
  let current = directory
  while (!existsSync(current)) {
    missing.push(current)
    const parent = dirname(current)
    if (parent === current) throw new Error(`no existing ancestor for ${directory}`)
    current = parent
  }
  for (const path of missing.reverse()) {
    mkdirSync(path)
    created.push(path)
  }
}

async function judgeOriginalPath(
  file: string,
  checkout: string,
  judge: string,
  installedRoot: string,
): Promise<HubImportJudgment | null> {
  const original = relative(checkout, file).split(sep).join('/')
  try {
    const judgment = await runInstalledJudge(
      judge,
      [original, original, checkout, '--path-only'],
      installedRoot,
    )
    return judgment.status === 'ok' ? null : judgment
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `judge could not run (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

export async function hubImportJudgeCommand(
  text: string,
  openDatabase: () => Database = openReadOnlyDatabase,
): Promise<HubImportJudgment> {
  let payload: ToolPayload
  try {
    payload = JSON.parse(text) as ToolPayload
  } catch {
    throw new Error('input must be valid JSON')
  }
  const file = targetFile(payload)
  if (!file) return { status: 'unchecked', findings: [], reason: 'tool input has no file path' }

  let database: Database
  try {
    database = openDatabase()
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `project register could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  let checkout: string | null
  try {
    checkout = registeredCheckout(file, database)
  } finally {
    database.close()
  }
  if (!checkout) return { status: 'ok', findings: [] }

  const installedRoot = resolve(import.meta.dir, '../..')
  const judge = join(installedRoot, 'scripts/check-architecture-file.ts')
  const original = relative(checkout, file).split(sep).join('/')
  const pathJudgment = await judgeOriginalPath(file, checkout, judge, installedRoot)
  if (pathJudgment) return pathJudgment

  let content: string
  try {
    content = proposedContent(file, payload)
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `candidate could not be reconstructed (${error instanceof Error ? error.message : String(error)})`,
    }
  }

  const candidate = join(dirname(file), `.architecture-guard-${randomUUID()}${extname(file)}`)
  const createdDirectories: string[] = []
  try {
    createCandidateDirectories(dirname(candidate), createdDirectories)
    writeFileSync(candidate, content)
    return await runInstalledJudge(
      judge,
      [relative(checkout, candidate).split(sep).join('/'), original, checkout],
      installedRoot,
    )
  } catch (error) {
    return {
      status: 'unchecked',
      findings: [],
      reason: `judge could not run (${error instanceof Error ? error.message : String(error)})`,
    }
  } finally {
    rmSync(candidate, { force: true })
    for (const directory of createdDirectories.reverse()) rmdirSync(directory)
  }
}
