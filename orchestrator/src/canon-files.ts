// concern: canon-files
/** Knows how to collect committed canon files from a git tree. Must not know stores, commands, runs, routing, transports, or worktrees. */
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { inspectionGitEnv } from '../../shared/git.ts'
import type { CanonFile } from './canon-lint.ts'

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

function isCanonPath(path: string): boolean {
  return (
    posix.basename(path) === 'AGENTS.md' ||
    posix.basename(path) === 'CLAUDE.md' ||
    /^\.agents\/(?:rules|contexts|reference)\/[^/]+\.md$/.test(path)
  )
}

export function canonGitRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim()
}

export function collectCanonFiles(root: string): CanonFile[] {
  const entries = git(root, ['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(\d+) [0-9a-f]+ \d+\t([\s\S]+)$/)
      if (!match) throw new Error(`could not parse git ls-files entry ${JSON.stringify(entry)}`)
      return { mode: match[1]!, path: match[2]! }
    })
    .filter(({ path }) => isCanonPath(path))
  const tracked = new Set(entries.map(({ path }) => path))
  return entries.map(({ mode, path }) => {
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
