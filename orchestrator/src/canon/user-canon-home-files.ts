// concern: user-canon-home-files
/** Reads and applies harness-home canon files. Must not know stores, commands, runs, routing, or transports. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { StateEnvironment } from '../../../shared/state-directory.ts'
import {
  applyBackedUpSettingsWrites,
  backupSettingsWrites,
  planSettingsWrite,
  writeNewSettingsFileAtomically,
} from '../settings/settings-write.ts'
import {
  decideUserCanonHydration,
  mapUserCanonHomePath,
  USER_CANON_HOME_MAPPINGS,
  USER_CANON_MANAGED_MARKER,
  type UserCanonHomeMapping,
} from './user-canon-home.ts'

export type UserCanonHomeFile = { slug: string; path: string; text: string }
export type UserCanonHomeTarget = {
  mapping: UserCanonHomeMapping
  path: string
  installed: boolean
}
export type UserCanonHomePlan = {
  home: UserCanonHomeTarget
  writes: { slug: string; path: string; body: string; existing: boolean }[]
  adopts: { slug: string; path: string; body: string }[]
  deletes: { slug: string; path: string }[]
}

export function userCanonHomesFromEnvironment(env: NodeJS.ProcessEnv): UserCanonHomeTarget[] {
  const home = env.HOME
  if (!home) throw new Error('HOME is required to locate user canon homes')
  return USER_CANON_HOME_MAPPINGS.map((mapping) => {
    const override = mapping.environment ? env[mapping.environment] : undefined
    const path = resolve(
      override && override.length > 0 ? override : join(home, mapping.defaultDirectory),
    )
    return { mapping, path, installed: existsSync(path) }
  })
}

export function userCanonHomeInstallationStatus(target: UserCanonHomeTarget): string | null {
  return target.installed ? null : `${target.mapping.harness} ${target.path}: not installed`
}

export function userCanonHomePlanDrift(plan: UserCanonHomePlan): number {
  return plan.writes.length + plan.adopts.length + plan.deletes.length
}

export function collectUserCanonHome(target: UserCanonHomeTarget): UserCanonHomeFile[] {
  if (!target.installed) return []
  assertRegularPath(target.path, 'directory', target)
  const relativePaths: string[] = [target.mapping.entry.home]
  const rules = target.mapping.rules && join(target.path, target.mapping.rules.homeDirectory)
  if (rules && existsSync(rules)) {
    assertRegularPath(rules, 'directory', target)
    relativePaths.push(
      ...readdirSync(rules)
        .map((name) => join(target.mapping.rules!.homeDirectory, name))
        .filter((path) => mapHomePathToSlug(target.mapping, path) !== null),
    )
  }
  return relativePaths.flatMap((relativePath) => {
    const path = join(target.path, relativePath)
    const slug = mapHomePathToSlug(target.mapping, relativePath)
    if (!slug || !existsSync(path)) return []
    assertRegularPath(path, 'file', target)
    assertResolvedUnderHome(target, path)
    return [{ slug, path, text: readFileSync(path, 'utf8') }]
  })
}

export function planUserCanonHome(input: {
  home: UserCanonHomeTarget
  rows: { slug: string; body: string }[]
  files: UserCanonHomeFile[]
  adopt?: boolean
}): UserCanonHomePlan {
  const rows = new Map(
    input.rows.flatMap((row) => {
      const relativePath = mapUserCanonHomePath(input.home.mapping, row.slug)
      return relativePath ? [[relativePath, row] as const] : []
    }),
  )
  const files = new Map(
    input.files.flatMap((file) => {
      const relativePath = mapUserCanonHomePath(input.home.mapping, file.slug)
      return relativePath ? [[relativePath, file] as const] : []
    }),
  )
  const paths = new Set([...rows.keys(), ...files.keys()])
  const writes: UserCanonHomePlan['writes'] = []
  const adopts: UserCanonHomePlan['adopts'] = []
  const deletes: UserCanonHomePlan['deletes'] = []
  for (const relativePath of [...paths].sort()) {
    const row = rows.get(relativePath)
    const file = files.get(relativePath)
    const path = join(input.home.path, relativePath)
    const decision = decideUserCanonHydration({
      storeBody: row?.body ?? null,
      homeText: file?.text ?? null,
    })
    if (decision.action === 'refuse') {
      if (input.adopt) {
        assertSingleLinkAdoptPath(input.home, path)
        adopts.push({
          slug: row!.slug,
          path,
          body: `${USER_CANON_MANAGED_MARKER}${row!.body}`,
        })
        continue
      }
      throw new Error(
        `refusing to overwrite unmarked ${input.home.mapping.harness} home file ${path}: its content differs from user canon\n` +
          'keep the file (file wins): orch canon import --user\n' +
          'keep the store (store wins): orch canon hydrate --user --adopt',
      )
    }
    if (decision.action === 'write') {
      writes.push({ slug: row!.slug, path, body: decision.body, existing: file !== undefined })
    }
    if (decision.action === 'delete') deletes.push({ slug: file!.slug, path })
  }
  return { home: input.home, writes, adopts, deletes }
}

export function applyUserCanonHomePlan(
  plan: UserCanonHomePlan,
  environment: StateEnvironment = process.env,
  dryRun = false,
): string[] {
  if (dryRun) return []
  if (plan.writes.length === 0 && plan.adopts.length === 0 && plan.deletes.length === 0) return []
  for (const row of [...plan.deletes, ...plan.writes, ...plan.adopts]) {
    preflightMutation(plan.home, row.path)
  }
  const existingWrites = [...plan.writes.filter((row) => row.existing), ...plan.adopts].map((row) =>
    planSettingsWrite(row.path, row.body),
  )
  const backedUpWrites = backupSettingsWrites(existingWrites, environment)
  for (const row of plan.deletes) rmSync(row.path)
  for (const row of plan.writes.filter((row) => !row.existing)) {
    const parent = dirname(row.path)
    if (!existsSync(parent)) {
      const rules = plan.home.mapping.rules
      if (!rules || parent !== join(plan.home.path, rules.homeDirectory)) {
        throw new Error(
          `refusing ${plan.home.mapping.harness} home path ${row.path}: parent directory does not exist`,
        )
      }
      mkdirSync(parent)
      assertRegularPath(parent, 'directory', plan.home)
      assertResolvedUnderHome(plan.home, parent)
    }
    writeNewSettingsFileAtomically(row.path, row.body)
    assertResolvedUnderHome(plan.home, row.path)
  }
  return applyBackedUpSettingsWrites(backedUpWrites, environment)
}

function assertSingleLinkAdoptPath(target: UserCanonHomeTarget, path: string): void {
  const stat = lstatSync(path)
  if (stat.nlink !== 1) {
    throw new Error(
      `refusing to adopt ${target.mapping.harness} home file ${path}: hard links are not allowed; ` +
        'replace it with a singly linked regular file',
    )
  }
}

function refuseUnsafePath(target: UserCanonHomeTarget, path: string, detail: string): never {
  throw new Error(
    `refusing ${target.mapping.harness} home path ${path}: ${detail}; replace the link with a regular file or directory`,
  )
}

function assertRegularPath(
  path: string,
  expected: 'file' | 'directory',
  target: UserCanonHomeTarget,
): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    refuseUnsafePath(target, path, `symbolic link targets ${readlinkSync(path)}`)
  }
  if (expected === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    refuseUnsafePath(target, path, `expected a regular ${expected}`)
  }
  if (expected === 'file' && stat.nlink !== 1) {
    refuseUnsafePath(target, path, 'hard links are not allowed')
  }
}

function assertResolvedUnderHome(target: UserCanonHomeTarget, path: string): void {
  const realHome = realpathSync(target.path)
  const realPath = realpathSync(path)
  const fromHome = relative(realHome, realPath)
  if (
    fromHome === '..' ||
    fromHome.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromHome)
  ) {
    refuseUnsafePath(target, path, `resolved outside ${realHome} to ${realPath}`)
  }
}

function preflightMutation(target: UserCanonHomeTarget, path: string): void {
  const absoluteHome = resolve(target.path)
  const absolutePath = resolve(path)
  const fromHome = relative(absoluteHome, absolutePath)
  if (
    fromHome === '..' ||
    fromHome.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromHome)
  ) {
    refuseUnsafePath(target, path, `is outside ${absoluteHome}`)
  }
  const segments = fromHome.split(/[\\/]/).filter(Boolean)
  let cursor = absoluteHome
  assertRegularPath(cursor, 'directory', target)
  assertResolvedUnderHome(target, cursor)
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    if (!existsSync(cursor)) break
    assertRegularPath(cursor, index === segments.length - 1 ? 'file' : 'directory', target)
    assertResolvedUnderHome(target, cursor)
  }
}

function mapHomePathToSlug(mapping: UserCanonHomeMapping, path: string): string | null {
  if (path === mapping.entry.home) return mapping.entry.canon
  if (!mapping.rules) return null
  const prefix = `${mapping.rules.homeDirectory}/`
  if (!path.startsWith(prefix)) return null
  const name = path.slice(prefix.length)
  return /^[^/]+\.md$/.test(name) ? `${mapping.rules.canonPrefix}${name}` : null
}
