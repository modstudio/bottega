// concern: user-canon-home-files
/** Reads and applies Claude-home canon files. Must not know stores, commands, runs, routing, or transports. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  decideUserCanonHydration,
  isUserCanonHomePath,
  mapUserCanonPath,
} from './user-canon-home.ts'

export type UserCanonHomeFile = { slug: string; path: string; text: string }
export type UserCanonHomePlan = {
  claudeHome: string
  writes: { slug: string; path: string; body: string }[]
  deletes: { slug: string; path: string }[]
}

export function claudeHomeFromEnvironment(env: NodeJS.ProcessEnv): string {
  const home = env.HOME
  if (!home) throw new Error('HOME is required to locate the Claude home')
  return join(home, '.claude')
}

export function collectUserCanonHome(claudeHome: string): UserCanonHomeFile[] {
  if (!existsSync(claudeHome)) return []
  assertRegularPath(claudeHome, 'directory')
  const relativePaths = isUserCanonHomePath('CLAUDE.md') ? ['CLAUDE.md'] : []
  const rules = join(claudeHome, 'rules')
  if (existsSync(rules)) {
    assertRegularPath(rules, 'directory')
    relativePaths.push(
      ...readdirSync(rules)
        .map((name) => join('rules', name))
        .filter(isUserCanonHomePath),
    )
  }
  return relativePaths.flatMap((relativePath) => {
    const path = join(claudeHome, relativePath)
    const slug = mapUserCanonPath({ kind: 'claude', path: relativePath })
    if (!slug || !existsSync(path)) return []
    assertRegularPath(path, 'file')
    assertResolvedUnderClaudeHome(claudeHome, path)
    return [{ slug, path, text: readFileSync(path, 'utf8') }]
  })
}

export function planUserCanonHome(input: {
  claudeHome: string
  rows: { slug: string; body: string }[]
  files: UserCanonHomeFile[]
}): UserCanonHomePlan {
  const rows = new Map(
    input.rows.flatMap((row) => {
      const relativePath = mapUserCanonPath({ kind: 'canon', path: row.slug })
      return relativePath ? [[relativePath, row] as const] : []
    }),
  )
  const files = new Map(
    input.files.flatMap((file) => {
      const relativePath = mapUserCanonPath({ kind: 'canon', path: file.slug })
      return relativePath ? [[relativePath, file] as const] : []
    }),
  )
  const paths = new Set([...rows.keys(), ...files.keys()])
  const writes: UserCanonHomePlan['writes'] = []
  const deletes: UserCanonHomePlan['deletes'] = []
  for (const relativePath of [...paths].sort()) {
    const row = rows.get(relativePath)
    const file = files.get(relativePath)
    const path = join(input.claudeHome, relativePath)
    const decision = decideUserCanonHydration({
      storeBody: row?.body ?? null,
      homeText: file?.text ?? null,
    })
    if (decision.action === 'refuse') {
      throw new Error(
        `refusing to overwrite unmarked Claude home file ${path}: its content differs from user canon\n` +
          'cleared by: orch canon import --user',
      )
    }
    if (decision.action === 'write') writes.push({ slug: row!.slug, path, body: decision.body })
    if (decision.action === 'delete') deletes.push({ slug: file!.slug, path })
  }
  return { claudeHome: input.claudeHome, writes, deletes }
}

export function applyUserCanonHomePlan(plan: UserCanonHomePlan): void {
  ensureClaudeHome(plan.claudeHome)
  for (const row of [...plan.deletes, ...plan.writes]) preflightMutation(plan.claudeHome, row.path)
  for (const row of plan.deletes) rmSync(row.path)
  for (const row of plan.writes) {
    mkdirSync(dirname(row.path), { recursive: true })
    preflightMutation(plan.claudeHome, row.path)
    writeFileSync(row.path, row.body)
    assertResolvedUnderClaudeHome(plan.claudeHome, row.path)
  }
}

function ensureClaudeHome(claudeHome: string): void {
  if (existsSync(claudeHome)) {
    assertRegularPath(claudeHome, 'directory')
    return
  }
  const parent = dirname(claudeHome)
  assertRegularPath(parent, 'directory')
  mkdirSync(claudeHome)
  assertRegularPath(claudeHome, 'directory')
}

function refuseUnsafePath(path: string, detail: string): never {
  throw new Error(
    `refusing Claude home path ${path}: ${detail}; replace the link with a regular file or directory`,
  )
}

function assertRegularPath(path: string, expected: 'file' | 'directory'): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    refuseUnsafePath(path, `symbolic link targets ${readlinkSync(path)}`)
  }
  if (expected === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    refuseUnsafePath(path, `expected a regular ${expected}`)
  }
}

function assertResolvedUnderClaudeHome(claudeHome: string, path: string): void {
  const realHome = realpathSync(claudeHome)
  const realPath = realpathSync(path)
  const fromHome = relative(realHome, realPath)
  if (
    fromHome === '..' ||
    fromHome.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromHome)
  ) {
    refuseUnsafePath(path, `resolved outside ${realHome} to ${realPath}`)
  }
}

function preflightMutation(claudeHome: string, path: string): void {
  const absoluteHome = resolve(claudeHome)
  const absolutePath = resolve(path)
  const fromHome = relative(absoluteHome, absolutePath)
  if (
    fromHome === '..' ||
    fromHome.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(fromHome)
  ) {
    refuseUnsafePath(path, `is outside ${absoluteHome}`)
  }
  const segments = fromHome.split(/[\\/]/).filter(Boolean)
  let cursor = absoluteHome
  assertRegularPath(cursor, 'directory')
  assertResolvedUnderClaudeHome(absoluteHome, cursor)
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment)
    if (!existsSync(cursor)) break
    assertRegularPath(cursor, index === segments.length - 1 ? 'file' : 'directory')
    assertResolvedUnderClaudeHome(absoluteHome, cursor)
  }
}
