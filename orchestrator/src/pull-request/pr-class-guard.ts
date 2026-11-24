// concern: pull-request
/** Pure admission for the class guard declared by a measured defect fix. */

export type ClassGuardMeasurement = { className: string; command: string; count: number }
export type ClassGuardExec = { command: string; output: string; exitCode: number; createdAt: string }

export type ClassGuardDecision = { kind: 'allow' } | { kind: 'refuse'; message: string }

const rerun = (worktree: string, command: string) =>
  `bottega workflow exec --cwd ${worktree} -- ${command}`

export function decidePullRequestClassGuard(input: {
  applies: boolean
  body: string
  measurement?: ClassGuardMeasurement
  implementClosedAt?: string
  execs: readonly ClassGuardExec[]
  worktree: string
}): ClassGuardDecision {
  if (!input.applies) return { kind: 'allow' }
  const measurement = input.measurement
  if (!measurement) return { kind: 'allow' }
  const line = input.body.split(/\r?\n/).find((candidate) => candidate.startsWith('Class guard:'))
  if (!line)
    return {
      kind: 'refuse',
      message: 'fix-defect pull request body is missing `Class guard: <guard name> (before <N>, after <M>)`',
    }
  const parsed = /^Class guard:\s*(.*?)\s*\(before (\d+), after (\d+)\)$/.exec(line)
  if (!parsed)
    return {
      kind: 'refuse',
      message: 'the Class guard line must be exactly `Class guard: <guard name> (before <N>, after <M>)`',
    }
  if (!parsed[1]?.trim())
    return { kind: 'refuse', message: 'the Class guard line is missing the guard name' }
  if (Number(parsed[2]) !== measurement.count)
    return {
      kind: 'refuse',
      message: `the Class guard before count must equal the measure-class count ${measurement.count}`,
    }
  const afterExec = input.execs.find(
    (entry) =>
      entry.command === measurement.command &&
      entry.exitCode === 0 &&
      (!input.implementClosedAt || entry.createdAt >= input.implementClosedAt),
  )
  if (!afterExec)
    return {
      kind: 'refuse',
      message: `the Class guard has no successful post-implement measurement; run \`${rerun(input.worktree, measurement.command)}\``,
    }
  const lastLine = afterExec.output
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1)
  if (!lastLine || !/^\d+$/.test(lastLine) || Number(parsed[3]) !== Number(lastLine))
    return {
      kind: 'refuse',
      message: `the Class guard after count must equal the post-implement measurement${lastLine && /^\d+$/.test(lastLine) ? ` ${lastLine}` : ''}; rerun \`${rerun(input.worktree, measurement.command)}\` and update the line`,
    }
  return { kind: 'allow' }
}
