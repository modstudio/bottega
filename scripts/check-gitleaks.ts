import { fileURLToPath } from 'node:url'
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
const logOptions = rangeCount.stdout.toString().trim() === '0' ? [] : [`--log-opts=${range}`]
const scan = Bun.spawnSync(
  [
    gitleaks,
    'git',
    root,
    '--config',
    `${root}.gitleaks.toml`,
    '--redact',
    '--exit-code',
    '1',
    ...logOptions,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
)

process.exit(scan.exitCode)
