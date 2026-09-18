// concern: canon-files
/** Knows how to collect committed canon files from a git tree. Must not know stores, commands, runs, routing, transports, or worktrees. */
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { inspectionGitEnv } from '../../../shared/git.ts'
import type { CanonFile, CanonLintInput, CanonSourceText } from './canon-lint.ts'

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: inspectionGitEnv(),
  })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`git -C ${cwd} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.toString()
}

export function isCanonPath(path: string): boolean {
  return (
    posix.basename(path) === 'AGENTS.md' ||
    posix.basename(path) === 'CLAUDE.md' ||
    /^\.agents\/(?:rules|contexts|reference)\/[^/]+\.md$/.test(path)
  )
}

function isHydrationPath(path: string): boolean {
  return isCanonPath(path) || path === '.claude/rules' || path === '.agents/rules/contexts'
}

export function canonGitRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim()
}

function trackedEntries(root: string): { mode: string; path: string }[] {
  return git(root, ['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(\d+) [0-9a-f]+ \d+\t([\s\S]+)$/)
      if (!match) throw new Error(`could not parse git ls-files entry ${JSON.stringify(entry)}`)
      return { mode: match[1]!, path: match[2]! }
    })
}

function readCanonFiles(
  root: string,
  entries: { mode: string; path: string }[],
  include = isCanonPath,
): CanonFile[] {
  const canonEntries = entries.filter(({ path }) => include(path))
  const tracked = new Set(entries.map(({ path }) => path))
  return canonEntries.map(({ mode, path }) => {
    const absolute = resolve(root, path)
    if (mode !== '120000') return { path, text: readFileSync(absolute, 'utf8') }
    const symlinkTarget = readlinkSync(absolute)
    const targetPath = posix.isAbsolute(symlinkTarget)
      ? posix.normalize(symlinkTarget)
      : posix.normalize(posix.join(posix.dirname(path), symlinkTarget))
    return {
      path,
      text:
        tracked.has(targetPath) && existsSync(resolve(root, targetPath))
          ? readFileSync(resolve(root, targetPath), 'utf8')
          : '',
      symlinkTarget,
    }
  })
}

const SOURCE_PATH = /\.(?:ts|tsx|js|mjs|cjs|py|sh|php|vue)$/

function readSourceTexts(
  root: string,
  entries: { mode: string; path: string }[],
): CanonSourceText[] {
  return entries
    .filter(
      ({ mode, path }) =>
        mode !== '120000' && SOURCE_PATH.test(path) && existsSync(resolve(root, path)),
    )
    .map(({ path }) => ({ path, text: readFileSync(resolve(root, path), 'utf8') }))
}

function readPackageScripts(root: string, entries: { path: string }[]): string[] {
  const scripts = new Set<string>()
  for (const { path } of entries.filter(
    ({ path }) => posix.basename(path) === 'package.json' && existsSync(resolve(root, path)),
  )) {
    const json = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    for (const name of Object.keys(json.scripts ?? {})) scripts.add(name)
  }
  return [...scripts].sort()
}

export function collectCanonLintInput(root: string): CanonLintInput {
  const entries = trackedEntries(root)
  return {
    files: readCanonFiles(root, entries),
    trackedPaths: entries.map(({ path }) => path),
    packageScripts: readPackageScripts(root, entries),
    sourceTexts: readSourceTexts(root, entries),
  }
}

export function collectCanonTree(root: string): CanonFile[] {
  const entries = trackedEntries(root)
  return readCanonFiles(root, entries, isHydrationPath)
}
