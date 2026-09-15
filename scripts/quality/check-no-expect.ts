import { noExpectFindings } from './no-expect'
import { type Finding, introducedFindings } from './ratchet'

type Mode = { kind: 'staged' } | { kind: 'base'; ref: string }

function git(args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim()
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.toString()
}

function parseMode(argv: string[]): Mode {
  if (argv.length !== 1) throw new Error('usage: check-no-expect.ts (--staged | --base=<ref>)')
  if (argv[0] === '--staged') return { kind: 'staged' }
  if (argv[0]!.startsWith('--base=') && argv[0]!.length > '--base='.length) {
    return { kind: 'base', ref: argv[0]!.slice('--base='.length) }
  }
  throw new Error('usage: check-no-expect.ts (--staged | --base=<ref>)')
}

function filesAt(ref: string) {
  return (git(['ls-tree', '-r', '--name-only', ref]) ?? '')
    .split('\n')
    .filter((file) => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
}

function reportAt(ref: string): Finding[] {
  const findings: Finding[] = []
  for (const file of filesAt(ref)) {
    findings.push(...noExpectFindings(file, git(['show', `${ref}:${file}`])))
  }
  return findings
}

function stagedFiles() {
  return (git(['ls-files']) ?? '')
    .split('\n')
    .filter((file) => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
}

function stagedReport(): Finding[] {
  const findings: Finding[] = []
  for (const file of stagedFiles()) {
    findings.push(...noExpectFindings(file, git(['show', `:${file}`])))
  }
  return findings
}

try {
  const mode = parseMode(Bun.argv.slice(2))
  const base = reportAt(mode.kind === 'staged' ? 'HEAD' : mode.ref)
  const head = mode.kind === 'staged' ? stagedReport() : reportAt('HEAD')
  const introduced = introducedFindings(base, head)
  if (introduced.length === 0) {
    console.log('no-expect ratchet: OK — no vacuous tests introduced')
  } else {
    console.error(`no-expect ratchet: ${introduced.length} vacuous test(s) introduced:`)
    for (const finding of introduced) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.message}`)
    }
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
