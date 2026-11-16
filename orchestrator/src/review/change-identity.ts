import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ChangeIdentityGitResult = {
  ok: boolean
  out: string
  err: string
  stdout: Uint8Array
}

export type ChangeIdentityGitRunner = (
  args: string[],
  stdin?: Uint8Array,
  stdinFile?: string,
) => ChangeIdentityGitResult

function patchIdentity(
  runner: ChangeIdentityGitRunner,
  diffArgs: string[],
  patchIdArgs: string[],
): string {
  const directory = mkdtempSync(join(tmpdir(), 'review-change-identity-'))
  const diffPath = join(directory, 'change.diff')
  try {
    const diff = runner([...diffArgs, `--output=${diffPath}`])
    if (!diff.ok) throw new Error(`git ${diffArgs.join(' ')} failed: ${diff.err}`)
    const id = runner(patchIdArgs, undefined, diffPath)
    if (!id.ok) throw new Error(`git ${patchIdArgs.join(' ')} failed: ${id.err}`)
    return id.out.split(/\s+/)[0] ?? ''
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Stable content identity for a change, including literal binary payloads. */
export function changeIdentity(runner: ChangeIdentityGitRunner, from: string, to: string): string {
  const diffArgs = ['diff', '--binary', '--no-ext-diff', '--no-color', `${from}..${to}`]
  return patchIdentity(runner, diffArgs, ['patch-id', '--stable'])
}

/** Context-free, whitespace-sensitive content identity for a change. */
export function zeroContextChangeIdentity(
  runner: ChangeIdentityGitRunner,
  from: string,
  to: string,
): string {
  const diffArgs = [
    'diff',
    '-U0',
    '--binary',
    '--no-ext-diff',
    '--no-color',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `${from}..${to}`,
  ]
  return patchIdentity(runner, diffArgs, ['patch-id', '--verbatim'])
}
