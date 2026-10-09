import { fileURLToPath } from 'node:url'
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
const rangeCount = Bun.spawnSync(['git', 'rev-list', '--count', range], {
  cwd: root,
  stdout: 'pipe',
  stderr: 'pipe',
})
if (rangeCount.exitCode !== 0) {
  const detail = rangeCount.stderr.toString().trim()
  console.error(`check-gitleaks could not inspect ${range}${detail ? `: ${detail}` : ''}`)
  process.exit(1)
}
const rangeCommitCount = Number(rangeCount.stdout.toString().trim())
const scans = planGitleaksScans({
  rangeCommitCount,
  range,
  repository: root,
  config: `${root}.gitleaks.toml`,
})

if (rangeCommitCount === 0) {
  const untracked = Bun.spawnSync(['git', 'ls-files', '--others', '--exclude-standard'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (untracked.exitCode !== 0) {
    const detail = untracked.stderr.toString().trim()
    console.error(`check-gitleaks could not inspect untracked files${detail ? `: ${detail}` : ''}`)
    process.exit(1)
  }
  if (untracked.stdout.toString().trim()) {
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
    const decision = decideGitleaksScan(
      scan.mode === 'history'
        ? { mode: 'history', expectedCommitCount: rangeCommitCount, exitCode: result.exitCode, log }
        : { mode: scan.mode, exitCode: result.exitCode, log },
    )
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
