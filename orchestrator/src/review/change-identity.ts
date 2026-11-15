export type ChangeIdentityGitResult = {
  ok: boolean
  out: string
  err: string
  stdout: Uint8Array
}

export type ChangeIdentityGitRunner = (
  args: string[],
  stdin?: Uint8Array,
) => ChangeIdentityGitResult

/** Stable content identity for a change, including literal binary payloads. */
export function changeIdentity(runner: ChangeIdentityGitRunner, from: string, to: string): string {
  const diffArgs = ['diff', '--binary', '--no-ext-diff', '--no-color', `${from}..${to}`]
  const diff = runner(diffArgs)
  if (!diff.ok) throw new Error(`git ${diffArgs.join(' ')} failed: ${diff.err}`)
  const id = runner(['patch-id', '--stable'], diff.stdout)
  if (!id.ok) throw new Error(`git patch-id --stable failed: ${id.err}`)
  return id.out.split(/\s+/)[0] ?? ''
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
  const diff = runner(diffArgs)
  if (!diff.ok) throw new Error(`git ${diffArgs.join(' ')} failed: ${diff.err}`)
  const id = runner(['patch-id', '--verbatim'], diff.stdout)
  if (!id.ok) throw new Error(`git patch-id --verbatim failed: ${id.err}`)
  return id.out.split(/\s+/)[0] ?? ''
}
