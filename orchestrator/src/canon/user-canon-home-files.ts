// concern: user-canon-home-files
/** Reads and applies Claude-home canon files. Must not know stores, commands, runs, routing, or transports. */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decideUserCanonHydration, mapUserCanonPath } from './user-canon-home.ts'

export type UserCanonHomeFile = { slug: string; path: string; text: string }
export type UserCanonHomePlan = {
  writes: { slug: string; path: string; body: string }[]
  deletes: { slug: string; path: string }[]
}

export function claudeHomeFromEnvironment(env: NodeJS.ProcessEnv): string {
  const home = env.HOME
  if (!home) throw new Error('HOME is required to locate the Claude home')
  return join(home, '.claude')
}

export function collectUserCanonHome(claudeHome: string): UserCanonHomeFile[] {
  const relativePaths = ['CLAUDE.md']
  const rules = join(claudeHome, 'rules')
  if (existsSync(rules)) {
    relativePaths.push(
      ...readdirSync(rules)
        .filter((name) => name.endsWith('.md'))
        .map((name) => join('rules', name)),
    )
  }
  return relativePaths.flatMap((relativePath) => {
    const path = join(claudeHome, relativePath)
    const slug = mapUserCanonPath({ kind: 'claude', path: relativePath })
    return slug && existsSync(path) ? [{ slug, path, text: readFileSync(path, 'utf8') }] : []
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
  return { writes, deletes }
}

export function applyUserCanonHomePlan(plan: UserCanonHomePlan): void {
  for (const row of plan.deletes) rmSync(row.path)
  for (const row of plan.writes) {
    mkdirSync(dirname(row.path), { recursive: true })
    writeFileSync(row.path, row.body)
  }
}
