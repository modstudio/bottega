import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { type ChangeViewMode, openChangeView } from '../../../shared/change-view.ts'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { type Finding, ratchetDecision } from '../../../shared/ratchet.ts'
import { projectAt } from '../project/projects.ts'
import { biomeFindings } from './biome-adapter.ts'
import { commandForSide, type SideFile, sideFiles, supportPlacements } from './ratchet-plan.ts'

type Reporter = Pick<Console, 'error' | 'log'>
type RatchetOptions = {
  cwd: string
  format: string
  staged: boolean
  base?: string
  support: string[]
  command: string[]
}

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, '--no-optional-locks', ...args], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString().trim() || 'no error output'}`,
    )
  }
  return result.stdout.toString().trim()
}

function checkoutRoot(cwd: string) {
  return git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
}

function comparisonBase(root: string, options: RatchetOptions): string {
  if (options.staged) return 'HEAD'
  if (options.base) return options.base
  const project = projectAt(root)
  const landing = project?.settings.trunk?.trim()
  if (!project || !landing) {
    throw new Error('could not resolve a registered project landing branch; pass --base <ref>')
  }
  return git(root, ['merge-base', 'HEAD', `origin/${landing}`])
}

function validatedSupport(root: string, paths: string[]) {
  for (const path of paths) {
    if (!path || isAbsolute(path) || relative('.', path).startsWith('..')) {
      throw new Error(
        `--support must name a relative path inside the checkout: ${path || '(empty)'}`,
      )
    }
    if (!existsSync(resolve(root, path))) {
      throw new Error(`--support path does not exist: ${path}`)
    }
  }
}

function materializeSupport(root: string, mirror: string, paths: string[]) {
  for (const placement of supportPlacements(root, mirror, paths)) {
    mkdirSync(dirname(placement.destination), { recursive: true })
    const stat = lstatSync(placement.source)
    if (stat.isDirectory()) symlinkSync(placement.source, placement.destination, 'dir')
    else copyFileSync(placement.source, placement.destination)
  }
}

function materializeFiles(root: string, files: SideFile[], support: string[]) {
  const mirror = mkdtempSync(join(tmpdir(), 'orch-ratchet-'))
  try {
    for (const file of files) {
      const destination = resolve(mirror, file.path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, file.content.text)
    }
    materializeSupport(root, mirror, support)
    return mirror
  } catch (error) {
    rmSync(mirror, { recursive: true, force: true })
    throw error
  }
}

function adapter(format: string): (text: string) => Finding[] {
  if (format === 'biome') return biomeFindings
  throw new Error(`unknown ratchet format ${JSON.stringify(format)}; available: biome`)
}

function runSide(
  root: string,
  cwd: string,
  command: string[],
  files: string[],
  parse: (text: string) => Finding[],
) {
  if (!files.length) return { ok: true as const, findings: [] }
  const argv = commandForSide(command, files, root)
  if (!argv.length) return { ok: false as const, reason: 'the linter command is empty' }
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  } catch (error) {
    return {
      ok: false as const,
      reason: `${argv[0]} could not run: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  let findings: Finding[]
  try {
    findings = parse(result.stdout?.toString() ?? '')
  } catch (error) {
    const detail = result.stderr?.toString().trim() ?? ''
    return {
      ok: false as const,
      reason: `could not parse ${argv[0]} output: ${error instanceof Error ? error.message : String(error)}${detail ? `; ${detail}` : ''}`,
    }
  }
  if (result.exitCode !== 0 && findings.length === 0) {
    return {
      ok: false as const,
      reason: `${argv[0]} exited ${result.exitCode}: ${result.stderr?.toString().trim() || 'no error output'}`,
    }
  }
  return { ok: true as const, findings }
}

function refusalReason(finding: ReturnType<typeof ratchetDecision>[number]) {
  if (finding.reason === 'grew') return `grew from ${finding.previousMeasure}`
  if (finding.reason === 'added-line') return 'finding is on an added line'
  if (finding.reason === 'new-measured') return 'new measured finding'
  return 'finding count increased'
}

export async function runRatchet(options: RatchetOptions, reporter: Reporter = console) {
  const root = checkoutRoot(options.cwd)
  validatedSupport(root, options.support)
  if (!options.command.includes('{files}')) throw new Error('linter command must contain {files}')
  const parse = adapter(options.format)
  const base = comparisonBase(root, options)
  const mode: ChangeViewMode = options.staged ? 'staged' : 'worktree'
  const view = openChangeView({ cwd: root, base, mode })
  const lintEntries = view.entries.filter(
    (entry) =>
      !options.support.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
  )
  const baseFiles = sideFiles(lintEntries, 'base', view.baseContent)
  const headFiles = sideFiles(lintEntries, 'head', view.headContent)
  let baseMirror: string | undefined
  let headMirror: string | undefined
  try {
    baseMirror = materializeFiles(root, baseFiles, options.support)
    const baseResult = runSide(
      root,
      baseMirror,
      options.command,
      baseFiles.map(({ path }) => path),
      parse,
    )
    if (options.staged) headMirror = materializeFiles(root, headFiles, options.support)
    const headRoot = headMirror ?? root
    const headResult = runSide(
      root,
      headRoot,
      options.command,
      headFiles.map(({ path }) => path),
      parse,
    )
    if (!headResult.ok) throw new Error(`current side failed: ${headResult.reason}`)
    reporter.log(`ratchet remaining: ${headResult.findings.length} findings on changed files only`)
    const unanalysedBase = new Set<string>()
    const baseFindings = baseResult.ok ? baseResult.findings : []
    if (!baseResult.ok) {
      reporter.error(`ratchet base side failed: ${baseResult.reason}`)
      for (const file of headFiles) unanalysedBase.add(file.path)
    }
    const refused = ratchetDecision({
      base: baseFindings,
      head: headResult.findings,
      change: view.facts,
      unanalysedBase,
    })
    for (const finding of refused) {
      reporter.error(
        `${finding.file}:${finding.line} ${finding.rule} ${finding.message}; ${refusalReason(finding)}`,
      )
    }
    return refused.length === 0
  } finally {
    if (baseMirror) rmSync(baseMirror, { recursive: true, force: true })
    if (headMirror) rmSync(headMirror, { recursive: true, force: true })
  }
}
