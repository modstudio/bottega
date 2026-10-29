// concern: secret-scan
/** Scans text with default gitleaks rules while retaining no matched text. */

import { tmpdir } from 'node:os'
import { decideSecretScanOutcome, type SecretScanOutcome } from './secret-scan-decision.ts'

const SECRET_SCAN_TIMEOUT_MS = 3_000

export type SecretScanner = (body: string) => SecretScanOutcome

export function scanTextForSecrets(body: string): SecretScanOutcome {
  const binary = Bun.which('gitleaks')
  if (!binary) return { status: 'unavailable', reason: 'gitleaks is not available on PATH' }

  const environment = { ...process.env }
  delete environment.GITLEAKS_CONFIG
  delete environment.GITLEAKS_CONFIG_TOML

  try {
    const child = Bun.spawnSync(
      [
        binary,
        'stdin',
        '--redact=100',
        '--report-format=json',
        '--report-path=-',
        '--no-banner',
        '--log-level=error',
      ],
      {
        cwd: tmpdir(),
        env: environment,
        stdin: Buffer.from(body),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: SECRET_SCAN_TIMEOUT_MS,
      },
    )
    return decideSecretScanOutcome({
      exitCode: child.exitCode,
      report: child.stdout.toString(),
      timedOut: child.exitedDueToTimeout === true,
      couldNotRun: false,
    })
  } catch {
    return decideSecretScanOutcome({
      exitCode: null,
      report: '',
      timedOut: false,
      couldNotRun: true,
    })
  }
}
