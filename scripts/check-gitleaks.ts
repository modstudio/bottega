const gitleaks = Bun.which('gitleaks')
if (!gitleaks) {
  console.log('check-gitleaks: skipped; the scan ran only in CI because gitleaks is not available')
  process.exit(0)
}

const root = new URL('..', import.meta.url).pathname
const scan = Bun.spawnSync([
  gitleaks,
  'git',
  root,
  '--config',
  `${root}.gitleaks.toml`,
  '--redact',
  '--exit-code',
  '1',
], { stdout: 'inherit', stderr: 'inherit' })

process.exit(scan.exitCode)
