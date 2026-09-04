#!/usr/bin/env bun
/**
 * Canon still names things the repository holds.
 *
 * A missing script, armed under a watcher that swallows the error, exits
 * silent — which is indistinguishable from the CLEAR state the watcher exists
 * to emit. The same shape as a boundary nobody checks: the instruction is
 * still read, and the absence is read as a pass.
 *
 * The test is tracked-ness, not presence on this disk. Canon is read by fresh
 * clones and other machines; an untracked file in one working tree makes
 * existsSync green while every other checkout is still wrong.
 *
 * Only backticked paths under PREFIXES are candidates. Prose is full of things
 * that look like paths and are not. Prefer missing a real violation to
 * inventing a false one.
 *
 * Behavioural claims ("orch land never pushes") are not checked. A check that
 * is wrong about behaviour is worse than no check.
 *
 * Default run is repo-only. To also check an external file's references
 * against this repository (the global canon is where the incident lived):
 *
 *   bun scripts/check-canon.ts --also ~/.claude/CLAUDE.md
 *
 * A scheduled job is the same command. bun run check does not pass --also:
 * a file this repo does not own must not fail this repo's gate.
 */
import { existsSync, readFileSync } from 'node:fs'
import { CONCERNS, PLATFORM_SLUG } from '../shared/brand.ts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

/**
 * Backticked paths must start with one of these. Written here so the cut is
 * readable, not inferred from whatever directories happen to exist.
 */
export const PREFIXES = [
  ...CONCERNS.map((c) => `${c}/`),
  'shared/',
  'scripts/',
  '.githooks/',
]

/** In-repo canon. CLAUDE.md is a symlink at the root and in two concerns; do not read it. */
export const CANON_FILES = [
  'AGENTS.md',
  ...CONCERNS.map((c) => `${c}/AGENTS.md`),
]

/**
 * A path the build writes. Absence means the checkout is unbuilt, which is a
 * fact about the machine — hub/web/dist is the case in this repository.
 */
const BUILT = /(^|\/)(?:dist|build)(?:\/|$)/

/**
 * Named, with a reason, because a heuristic here is how the gate would stop
 * checking something and stay green. Adding a fourth means writing down why.
 */
export const EXEMPTIONS: { path: string; reason: string }[] = [
  {
    path: 'orchestrator/orch.db',
    reason: 'gitignored runtime store; canon must name it, and it is per-machine state rather than a repository artifact.',
  },
  {
    path: 'scripts/worktree',
    reason: "another project's CLI, referenced as an example of how those projects invoke their own worktree tooling.",
  },
  {
    path: 'scripts/sync/main',
    reason: "another project's sync fabric, same reason.",
  },
]

const EXEMPT = new Set(EXEMPTIONS.map((e) => e.path))

export type Ctx = {
  /** True when git tracks this path, or some path beneath it if it is a directory. */
  tracked: (path: string) => boolean
  scripts: Set<string>
}

export type Finding = {
  file: string
  line: number
  kind: 'path' | 'script'
  name: string
  message: string
}

export type CheckResult = {
  findings: Finding[]
  examined: number
}

function globRoot(claimed: string): string {
  return (claimed.split('*')[0] ?? claimed).replace(/\/$/, '')
}

function claimedPaths(tick: string): string[] {
  const slug = `${PLATFORM_SLUG}/`
  const out: string[] = []
  for (const raw of tick.split(/\s+/)) {
    let piece = raw
    if (piece.startsWith(slug)) piece = piece.slice(slug.length)
    if (!PREFIXES.some((p) => piece.startsWith(p))) continue
    // Placeholders are examples, not references: `<repo>/.claude/worktrees/<KEY>`.
    if (/[<>]/.test(piece)) continue
    out.push(piece)
  }
  return out
}

/**
 * Every per-line check over one file. Exported so a rule that silently stops
 * firing has a test; a clean run is otherwise indistinguishable from a dead one.
 */
export function checkBody(file: string, body: string, ctx: Ctx): CheckResult {
  const findings: Finding[] = []
  let examined = 0

  body.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '')
    const at = `${file}:${i + 1}`

    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      for (const claimed of claimedPaths(m[1]!)) {
        examined++
        if (BUILT.test(claimed) || EXEMPT.has(claimed)) continue
        const root = globRoot(claimed)
        if (!root || ctx.tracked(root)) continue
        findings.push({
          file,
          line: i + 1,
          kind: 'path',
          name: claimed,
          message: `${at}: names \`${claimed}\`, which is not tracked in this repository.`,
        })
      }
    }

    // `bun run scripts/x.ts` runs a FILE; `bun run deploy:${app}` is named only
    // at run time. Neither is a key a package.json can define.
    for (const m of line.matchAll(/bun run (?:--cwd \S+ )?([a-z][\w:.-]*)(?![\w:.$/-])/g)) {
      const script = m[1]!
      examined++
      if (ctx.scripts.has(script)) continue
      findings.push({
        file,
        line: i + 1,
        kind: 'script',
        name: script,
        message: `${at}: \`bun run ${script}\` — no package.json defines it.`,
      })
    }
  })

  return { findings, examined }
}

export function trackedSet(names: Iterable<string>): (path: string) => boolean {
  const files = new Set(names)
  return (path: string) => {
    if (files.has(path)) return true
    const prefix = `${path}/`
    for (const f of files) {
      if (f.startsWith(prefix)) return true
    }
    return false
  }
}

export function loadTracked(root: string): Set<string> {
  const git = Bun.spawnSync(['git', 'ls-files', '-z'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (git.exitCode !== 0) {
    const err = new TextDecoder().decode(git.stderr).trim()
    throw new Error(`git ls-files failed: ${err || `exit ${git.exitCode}`}`)
  }
  return new Set(new TextDecoder().decode(git.stdout).split('\0').filter(Boolean))
}

export function loadScripts(root: string): Set<string> {
  const scripts = new Set<string>()
  for (const rel of [
    'package.json',
    'orchestrator/package.json',
    'hub/package.json',
    'hub/web/package.json',
  ]) {
    const path = `${root}/${rel}`
    if (!existsSync(path)) continue
    const json = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> }
    for (const name of Object.keys(json.scripts ?? {})) scripts.add(name)
  }
  return scripts
}

export function parseAlso(argv: string[]): string[] {
  const also: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--also') continue
    const path = argv[++i]
    if (!path) throw new Error('check-canon: --also needs a path')
    also.push(path)
  }
  return also
}

export function run(root: string, also: string[]): {
  findings: Finding[]
  examined: number
  files: string[]
} {
  const ctx: Ctx = {
    tracked: trackedSet(loadTracked(root)),
    scripts: loadScripts(root),
  }
  const files: string[] = []
  const findings: Finding[] = []
  let examined = 0

  for (const rel of CANON_FILES) {
    const path = `${root}/${rel}`
    if (!existsSync(path)) {
      findings.push({
        file: rel,
        line: 0,
        kind: 'path',
        name: rel,
        message: `${rel}: canon file is missing.`,
      })
      continue
    }
    files.push(rel)
    const result = checkBody(rel, readFileSync(path, 'utf8'), ctx)
    findings.push(...result.findings)
    examined += result.examined
  }

  for (const extra of also) {
    if (!existsSync(extra)) {
      findings.push({
        file: extra,
        line: 0,
        kind: 'path',
        name: extra,
        message: `--also ${extra}: file does not exist.`,
      })
      continue
    }
    files.push(extra)
    const result = checkBody(extra, readFileSync(extra, 'utf8'), ctx)
    findings.push(...result.findings)
    examined += result.examined
  }

  return { findings, examined, files }
}

function main(): number {
  let also: string[]
  try {
    also = parseAlso(process.argv.slice(2))
  } catch (e) {
    console.error((e as Error).message)
    return 1
  }

  let result: ReturnType<typeof run>
  try {
    result = run(ROOT, also)
  } catch (e) {
    console.error(`check-canon: ${(e as Error).message}`)
    return 1
  }

  const { findings, examined, files } = result
  const paths = findings.filter((f) => f.kind === 'path').length
  const scripts = findings.filter((f) => f.kind === 'script').length
  console.log(
    `check-canon: ${files.length} file(s), ${examined} reference(s)` +
      (also.length ? ` (+ ${also.length} --also)` : ''),
  )
  for (const f of files) console.log(`  ${f}`)
  for (const e of EXEMPTIONS) console.log(`  exempt  ${e.path}  ${e.reason}`)

  if (findings.length) {
    console.error(`\ncheck-canon: ${findings.length} violation(s)` +
      (paths || scripts ? ` (${paths} path, ${scripts} bun run)` : '') +
      `\n`)
    for (const f of findings) console.error(`  ${f.message}\n`)
    return 1
  }

  console.log('check-canon: ok')
  return 0
}

if (import.meta.main) process.exit(main())
