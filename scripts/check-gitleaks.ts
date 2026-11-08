import { fileURLToPath } from 'node:url'
import { gitAt } from '../shared/git.ts'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'
import { decideGitleaksScan, planGitleaksScans } from './check-gitleaks-plan'
import { resolveLandingBase } from './landing-base'

const gitleaks = Bun.which('gitleaks')
if (!gitleaks) {
  console.error('check-gitleaks: gitleaks is required; install it with: brew install gitleaks')
  process.exit(1)
}

const root = fileURLToPath(new URL('..', import.meta.url))
let mergeBase: string
try {
  mergeBase = resolveLandingBase(root, 'check-gitleaks').commit
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
const range = `${mergeBase}..HEAD`
const rangeCount = gitAt(root, ['rev-list', '--count', range])
if (rangeCount.code !== 0) {
  console.error(
    rangeCount.timedOut
      ? `git rev-list --count ${range} exceeded its bounded-call deadline`
      : `check-gitleaks could not inspect ${range}: ${rangeCount.stderr.trim() || 'no error output'}`,
  )
  process.exit(1)
}
const rangeCommitCount = Number(rangeCount.stdout.trim())
const scans = planGitleaksScans({
  rangeCommitCount,
  range,
  repository: root,
  config: `${root}.gitleaks.toml`,
})

if (rangeCommitCount === 0) {
  const untracked = gitAt(root, nulPathListArgs(['ls-files', '--others', '--exclude-standard']))
  if (untracked.code !== 0) {
    console.error(
      untracked.timedOut
        ? 'git ls-files --others --exclude-standard -z exceeded its bounded-call deadline'
        : `check-gitleaks could not inspect untracked files: ${untracked.stderr.trim() || 'no error output'}`,
    )
    process.exit(1)
  }
  if (splitNulPaths(untracked.stdout).length) {
    console.log(
      'check-gitleaks: untracked files are not scanned; they are scanned once staged or committed',
    )
  }
}

let failed = false
for (const scan of scans) {
  try {
    const result = Bun.spawnSync([gitleaks, ...scan.args], {
      stdout: 'inherit',
      stderr: 'pipe',
    })
    const log = result.stderr.toString()
    process.stderr.write(result.stderr)
    const decision = decideGitleaksScan({ exitCode: result.exitCode, log })
    if (decision.status === 'refused') {
      console.error(`check-gitleaks: ${scan.mode} scan refused: ${decision.message}`)
      console.error(`check-gitleaks: command: ${[gitleaks, ...scan.args].join(' ')}`)
      failed = true
    }
  } catch (error) {
    console.error(
      `check-gitleaks: ${scan.mode} scan failed to run: ${error instanceof Error ? error.message : String(error)}`,
    )
    failed = true
  }
}

process.exit(failed ? 1 : 0)
