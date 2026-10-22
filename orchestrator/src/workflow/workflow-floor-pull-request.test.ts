import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideFloorSatisfaction, decidePullRequestEvidence } from './workflow-floor.ts'

const url = 'https://github.com/acme/app/pull/7'
const link = {
  kind: 'link' as const,
  repository: 'acme/app',
  projectRepository: 'acme/app',
  state: 'OPEN',
  head: 'DEV-977-work',
  base: 'main',
  cursorBranch: 'DEV-977-work',
  trunk: 'main',
}
const exec = {
  kind: 'exec' as const,
  argv: [PLATFORM_SLUG, 'pr', 'create'],
  exitCode: 0,
  sessionBound: true,
  createdAfterStepActivation: true,
  checkoutBranch: 'DEV-977-work',
  headCommit: 'abc',
  cursorBranch: 'DEV-977-work',
  output: '',
}

test('pr-create exec evidence refuses help and requires a matching pull-request URL', () => {
  expect(
    decidePullRequestEvidence({ ...exec, argv: [PLATFORM_SLUG, 'pr', 'create', '--help'] }),
  ).toEqual({
    met: false,
    condition: 'the recorded command is a help invocation',
  })
  expect(
    decidePullRequestEvidence({ ...exec, argv: [PLATFORM_SLUG, 'pr', 'create', '-h'] }),
  ).toEqual({
    met: false,
    condition: 'the recorded command is a help invocation',
  })
  expect(decidePullRequestEvidence(exec)).toEqual({
    met: false,
    condition: 'the recorded command output does not contain a GitHub pull-request URL',
  })
  expect(decidePullRequestEvidence({ ...exec, output: 'created without a link' })).toEqual({
    met: false,
    condition: 'the recorded command output does not contain a GitHub pull-request URL',
  })
  expect(decidePullRequestEvidence({ ...exec, output: url })).toEqual({
    met: false,
    condition: 'the recorded command output pull-request URL could not be judged',
  })
  expect(decidePullRequestEvidence({ ...exec, output: `opened ${url}`, link })).toEqual({
    met: true,
  })
  expect(
    decideFloorSatisfaction({
      floors: [
        {
          kind: 'command-exit',
          deferrable: false,
          expectedExitCode: 0,
          expectedStatus: 'done',
          requirePullRequest: false,
          operatorRuling: false,
          commandEvidence: 'pull-request',
        },
      ],
      evidence: {
        exec: {
          id: 4,
          command: `${PLATFORM_SLUG} pr create`,
          argv: exec.argv,
          exitCode: 0,
          sessionMatches: true,
          sessionAdoptedCursor: false,
          createdAfterStepActivation: true,
          checkoutBranch: exec.checkoutBranch,
          headCommit: exec.headCommit,
          cursorBranch: exec.cursorBranch,
          output: `opened ${url}`,
        },
        pullRequest: { url, ...link },
      },
      enforcement: 'floors',
      finishing: false,
      openObligations: [],
    }).action,
  ).toBe('allow')
})
