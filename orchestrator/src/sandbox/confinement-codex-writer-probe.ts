// concern: Codex writer git confinement probe contract

import { PLATFORM_NAME } from '../../../shared/brand.ts'

type CommandProbeStatus = 'ran' | 'failed' | 'refused'
export type CommandProbe = { status: CommandProbeStatus; reason: string }

export const CODEX_PROBE_MODE = `codex sandbox -P ran without --approve-for-me; branch lifecycle belongs to ${PLATFORM_NAME.toLowerCase()} tree`

export const CODEX_GIT_MUTATION_PROBE = `if git branch codex-confinement-delete; then
  branch_delete_output="$(git branch -d codex-confinement-delete 2>&1)"
  branch_delete_status=$?
  case "$branch_delete_status:$branch_delete_output" in
    0:*) echo git-branch-delete=failed ;;
    *"packed-refs.lock"*"Operation not permitted"*) echo git-branch-delete=refused ;;
    *) echo git-branch-delete=failed ;;
  esac
else echo git-branch-delete=failed
fi
pack_refs_output="$(git pack-refs --all 2>&1)"
pack_refs_status=$?
case "$pack_refs_status:$pack_refs_output" in
  0:*) echo git-pack-refs=failed ;;
  *"packed-refs.lock"*"Operation not permitted"*) echo git-pack-refs=refused ;;
  *) echo git-pack-refs=failed ;;
esac`

export function codexShellArgument(index: number): string {
  return `\${${index}}`
}

export function codexWriterProbeOutput(stdout: string): {
  values: Map<string, string>
  commands: Record<string, CommandProbe>
} {
  const values = new Map(
    stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split('=', 2) as [string, string]),
  )
  const command = (
    name: string,
    expected: Exclude<CommandProbeStatus, 'failed'> = 'ran',
  ): CommandProbe => ({
    status: values.get(name) === expected ? expected : 'failed',
    reason:
      values.get(name) === expected
        ? expected === 'ran'
          ? 'succeeded'
          : 'packed-refs.lock: Operation not permitted'
        : 'failed',
  })
  return {
    values,
    commands: {
      pwd: command('pwd'),
      'git status': command('git-status'),
      'git commit': command('git-commit'),
      'git log': command('git-log'),
      'git branch -d': command('git-branch-delete', 'refused'),
      'git pack-refs': command('git-pack-refs', 'refused'),
    },
  }
}
