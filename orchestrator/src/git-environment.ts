// concern: git-environment
/**
 * Knows hermetic git invocation, git object/worktree environments, primitives,
 * and branch-ref observation. Must not know lifecycle policy, run state,
 * databases, routing, transports, or contracts.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mainCheckoutOf, scrubbedGitEnv } from '../../shared/git.ts'

/**
 * A MISSING WORKING DIRECTORY IS NOT A MISSING GIT.
 *
 * `Bun.spawnSync` reports a cwd that does not exist as
 * `ENOENT: posix_spawn 'git'`, which reads as "git is not installed" and sent a
 * real debugging session looking for a PATH problem that did not exist. Every
 * call here therefore checks the directory first and answers for itself.
 *
 * It matters because the normal case IS a missing directory: `orch discard` on
 * a worktree somebody already deleted by hand, or on a scratch repository that
 * has since been cleaned up.
 */
function cwdMissing(cwd: string): boolean {
  return !existsSync(cwd)
}

export type WorktreeObjectEnvironment = {
  GIT_OBJECT_DIRECTORY: string
  GIT_ALTERNATE_OBJECT_DIRECTORIES: string
}

/** Resolve linked-worktree metadata without invoking git (git itself uses this environment). */
function linkedWorktreePaths(cwd: string): {
  gitDir: string
  commonDir: string
  objects: string
} | null {
  const dotGit = join(cwd, '.git')
  if (!existsSync(dotGit)) return null
  let pointer: string
  try { pointer = readFileSync(dotGit, 'utf8').trim() } catch { return null }
  if (!pointer.startsWith('gitdir: ')) return null
  const gitDir = realpathSync(resolve(cwd, pointer.slice('gitdir: '.length)))
  const commonDir = realpathSync(resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()))
  const worktrees = realpathSync(join(commonDir, 'worktrees'))
  if (dirname(gitDir) !== worktrees) {
    throw new Error(
      `refusing writable git directory ${gitDir}: expected one worktree below ${worktrees}`,
    )
  }
  return { gitDir, commonDir, objects: join(gitDir, 'objects') }
}

function commonGitDir(cwd: string): string | null {
  const linked = linkedWorktreePaths(cwd)
  if (linked) return linked.commonDir
  const configured = gitConfigOk(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  if (!configured) return null
  try { return realpathSync(resolve(cwd, configured)) } catch { return null }
}

/** Use the isolated object store after it has been provisioned for this worktree. */
export function worktreeGitEnvironment(cwd: string): WorktreeObjectEnvironment | undefined {
  const paths = linkedWorktreePaths(cwd)
  if (!paths || !existsSync(paths.objects)) return undefined
  return {
    GIT_OBJECT_DIRECTORY: paths.objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(paths.commonDir, 'objects'),
  }
}

/** Drop a worker's repository routing before deriving routing for the target checkout. */
export function targetGitEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env = scrubbedGitEnv()
  // Operational git must not inherit a worker GIT_CONFIG_GLOBAL (hooksPath,
  // worker identity). Delete rather than /dev/null: landing commits keep
  // the user's ~/.gitconfig identity.
  delete env.GIT_CONFIG_GLOBAL
  delete env.GIT_CONFIG_SYSTEM
  delete env.GIT_CONFIG_NOSYSTEM
  return { ...env, ...worktreeGitEnvironment(cwd) }
}

/** A git invocation that throws with git's own words rather than a bare code. */
function git(args: string[], cwd: string): string {
  if (cwdMissing(cwd)) throw new Error(`git ${args[0]}: ${cwd} does not exist`)
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`)
  }
  return p.stdout.toString().trim()
}

/** Same, but a failure is an answer rather than an error. */
function gitOk(args: string[], cwd: string): string | null {
  if (cwdMissing(cwd)) return null
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}

/** Git's stdout with no trim, and an explicit failure rather than an empty string. */
function gitResult(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  if (cwdMissing(cwd)) return { ok: false, stdout: '', stderr: `${cwd} does not exist` }
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString().trim() || (p.exitCode === 0 ? '' : `exit ${p.exitCode}`),
  }
}

/** Measure the checkout's complete visible content without touching its index. */
export function contentTree(cwd: string): string {
  const temporary = join(tmpdir(), `orch-index-${process.pid}-${randomUUID()}`)
  mkdirSync(temporary, { recursive: true })
  const index = join(temporary, 'index')
  const env = { ...targetGitEnvironment(cwd), GIT_INDEX_FILE: index }
  try {
    const read = Bun.spawnSync(['git', 'read-tree', 'HEAD'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    if (read.exitCode !== 0) {
      throw new Error(`git read-tree HEAD failed while measuring content tree: ${read.stderr.toString().trim() || `exit ${read.exitCode}`}`)
    }
    const add = Bun.spawnSync(['git', 'add', '-A', '.'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    if (add.exitCode !== 0) {
      throw new Error(`git add -A . failed while measuring content tree: ${add.stderr.toString().trim() || `exit ${add.exitCode}`}`)
    }
    const write = Bun.spawnSync(['git', 'write-tree'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    if (write.exitCode !== 0) {
      throw new Error(`git write-tree failed while measuring content tree: ${write.stderr.toString().trim() || `exit ${write.exitCode}`}`)
    }
    return write.stdout.toString().trim()
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Read repository configuration without inheriting the worker config we return below. */
function gitConfigOk(args: string[], cwd: string): string | null {
  if (cwdMissing(cwd)) return null
  const p = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...targetGitEnvironment(cwd), GIT_CONFIG_COUNT: '0' },
    stdout: 'pipe', stderr: 'pipe',
  })
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}

/**
 * Git's output with NOT ONE BYTE CHANGED.
 *
 * A patch is a byte-exact artefact: `git apply` reads trailing newlines as
 * part of the hunk, so trimming one turns a valid patch into `corrupt patch at
 * line 301`. That is not hypothetical — `orch diff 638 > p && git apply p`
 * failed exactly that way on the first real implementation run, while the same
 * diff taken straight from git applied cleanly, because `gitOk` trims and a
 * diff is the one thing here that must not be tidied.
 *
 * Kept beside `gitOk` rather than replacing it: trimming is right for a branch
 * name or a commit id, where a stray newline is noise. It is only wrong for
 * content.
 */
function gitRaw(args: string[], cwd: string): string {
  if (cwdMissing(cwd)) return ''
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  return p.exitCode === 0 ? p.stdout.toString() : ''
}

/** Run git with byte-exact stdin, used to carry a working tree as a patch. */
function gitInput(args: string[], cwd: string, input: Uint8Array): void {
  if (cwdMissing(cwd)) throw new Error(`git ${args[0]}: ${cwd} does not exist`)
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: targetGitEnvironment(cwd),
    stdin: input, stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`)
  }
}

/** Byte-exact git output where failure must stop setup rather than look empty. */
function gitBytes(args: string[], cwd: string): Buffer {
  if (cwdMissing(cwd)) throw new Error(`git ${args[0]}: ${cwd} does not exist`)
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`)
  }
  return Buffer.from(p.stdout)
}

/**
 * The MAIN checkout, not this tree's own root.
 *
 * `--show-toplevel` from a worktree answers that worktree. Creating the next
 * one relative to it nests `orch-N` under the caller's tree, which is how an
 * one session lost a day: it ran orch from
 * `.../application/.claude/worktrees/AB-2581`, the project's script put the
 * new tree at the checkout root, and orch looked for it at
 * `AB-2581/.claude/worktrees/orch-657`. `--git-common-dir` is the main
 * `.git`; the working tree sits next to it.
 */
export function repoRootOf(cwd: string): string | null {
  return mainCheckoutOf(cwd, targetGitEnvironment(cwd))
}

/**
 * The metadata directory belonging to THIS linked worktree, and no other git state.
 *
 * A writing worker needs its index so `git add`/`git rm`-aware gates can run,
 * but granting the common `.git` directory would also expose refs, objects and
 * the main checkout's config. Resolve the linked-worktree pointers, then require the
 * result to be one immediate child of the common directory's `worktrees/`.
 */
export function worktreeGitDir(cwd: string): string {
  const paths = linkedWorktreePaths(cwd)
  if (!paths) throw new Error(`refusing writable git directory: ${cwd} is not a linked worktree`)
  return paths.gitDir
}

/** Create the worker-local object database and describe how git must read it. */
export function prepareWorktreeObjects(cwd: string): WorktreeObjectEnvironment {
  const paths = linkedWorktreePaths(cwd)
  if (!paths) throw new Error(`cannot isolate git objects: ${cwd} is not a linked worktree`)
  mkdirSync(paths.objects, { recursive: true })
  return worktreeGitEnvironment(cwd)!
}


export { cwdMissing, linkedWorktreePaths, commonGitDir, git, gitOk, gitResult, gitConfigOk, gitRaw, gitInput, gitBytes }

/** Read bounded git context without allowing observation failure to fail a run. */
export function gitContext(cwd: string, ...args: string[]): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, ...args],
      { env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'ignore' })
    if (p.exitCode !== 0) return null
    const value = new TextDecoder().decode(p.stdout).trim()
    return value ? value.slice(0, 200) : null
  } catch { return null }
}

export function branchOf(cwd: string): string | null {
  const branch = gitContext(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  return branch && branch !== 'HEAD' ? branch : null
}
