import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  decideFloorSatisfaction,
  decidePullRequestEvidence,
  githubPullRequestUrlIn,
  parseArtifactRef,
} from './workflow-floor.ts'

const url = 'https://github.com/acme/app/pull/7'
const withheldOutput = '[withheld: secret-shaped content]'
const withheldLine = '[withheld line: provider-prefix]'
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
  outputWithheld: false,
}
const pullRequestExit = {
  kind: 'command-exit' as const,
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'done',
  requirePullRequest: false,
  operatorRuling: false,
  commandEvidence: 'pull-request' as const,
}
const pullRequestArtifact = { ...pullRequestExit, kind: 'recorded-artifact' as const }
const EXEC_RECORD_ID = '00000000-0000-4000-8000-000000000004'
const matchingExecEvidence = {
  artifact: { ref: `exec:${EXEC_RECORD_ID}`, exists: true },
  exec: {
    id: 4,
    recordId: EXEC_RECORD_ID,
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
    outputWithheld: false,
  },
  pullRequest: { url, ...link },
}
const decide = (evidence: typeof matchingExecEvidence) =>
  decideFloorSatisfaction({
    floors: [pullRequestExit, pullRequestArtifact],
    evidence,
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })

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
  expect(
    decidePullRequestEvidence({
      ...exec,
      output: url,
      linkCondition: '--artifact exec:4: gh pr view failed: no pull request found',
    }),
  ).toEqual({
    met: false,
    condition: '--artifact exec:4: gh pr view failed: no pull request found',
  })
  expect(
    decidePullRequestEvidence({
      ...exec,
      output: `opened ${url}`,
      link: { ...link, head: 'other-branch' },
    }),
  ).toEqual({
    met: false,
    condition: "the pull request head is other-branch, not this cursor's DEV-977-work",
  })
  expect(decidePullRequestEvidence({ ...exec, output: withheldOutput, link })).toEqual({
    met: false,
    condition: 'the recorded output was withheld, so the pull-request URL cannot be read',
  })
  expect(decidePullRequestEvidence({ ...exec, output: withheldLine, link })).toEqual({
    met: false,
    condition: 'the recorded command output does not contain a GitHub pull-request URL',
  })
  expect(
    decidePullRequestEvidence({
      ...exec,
      argv: null,
      commandWithheld: true,
      output: `opened ${url}`,
      link,
    }),
  ).toEqual({
    met: false,
    condition: `the recorded command was withheld, so it cannot be identified as ${PLATFORM_SLUG} pr create`,
  })
  expect(
    decidePullRequestEvidence({ ...exec, output: `opened ${url}`, sessionBound: false, link }),
  ).toEqual({
    met: false,
    condition: 'the recorded command is not bound to this cursor session',
  })
  expect(decidePullRequestEvidence({ ...exec, output: `opened ${url}`, link })).toEqual({
    met: true,
  })
  expect(decide(matchingExecEvidence).action).toBe('allow')
})

test('a retained pull-request URL satisfies the floor when another output line is withheld', () => {
  expect(
    decidePullRequestEvidence({ ...exec, output: `opened ${url}\n${withheldLine}`, link }),
  ).toEqual({ met: true })
})

test('a pr-create exec from another session is refused on every pull-request floor', () => {
  const evidence = {
    ...matchingExecEvidence,
    exec: {
      ...matchingExecEvidence.exec,
      sessionMatches: false,
      sessionAdoptedCursor: false,
    },
  }
  expect(decide(evidence).action).toBe('refuse')
  const artifactOnly = decideFloorSatisfaction({
    floors: [pullRequestArtifact],
    evidence,
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })
  expect(artifactOnly.action).toBe('refuse')
  if (artifactOnly.action === 'refuse')
    expect(artifactOnly.message).toContain(
      'the recorded command is not bound to this cursor session',
    )
})

test('a pr-create exec predating the step names the pull-request link alternative', () => {
  const decision = decide({
    ...matchingExecEvidence,
    exec: { ...matchingExecEvidence.exec, createdAfterStepActivation: false },
  })
  expect(decision).toEqual({
    action: 'refuse',
    message: expect.stringContaining('pass `--artifact <the pull request link>`'),
  })
})

test('a withheld pr-create exec names the pull-request link remedy', () => {
  const decision = decideFloorSatisfaction({
    floors: [pullRequestExit],
    evidence: {
      exec: {
        ...matchingExecEvidence.exec,
        output: withheldOutput,
        outputWithheld: true,
      },
    },
    enforcement: 'floors',
    finishing: false,
    openObligations: [],
  })
  expect(decision.action).toBe('refuse')
  if (decision.action === 'refuse') {
    expect(decision.message).toContain(
      'the recorded output was withheld, so the pull-request URL cannot be read',
    )
    expect(decision.message).toContain('pass --artifact <pull-request link>')
    expect(decision.message).not.toContain(
      'the recorded command output does not contain a GitHub pull-request URL',
    )
  }
})

test('a masked pr-create exec is met when its command and pull-request link stay readable', () => {
  expect(
    decidePullRequestEvidence({
      ...exec,
      output: `credential [withheld: assignment]\n${url}`,
      outputWithheld: true,
      link,
    }),
  ).toEqual({ met: true })
})

test('parseArtifactRef accepts a GitHub pull-request URL only as the whole string', () => {
  expect(parseArtifactRef(url)).toEqual({ kind: 'pull-request', url })
  expect(parseArtifactRef(`${url}/files`)).toMatchObject({
    error: expect.stringContaining('--artifact'),
  })
  expect(githubPullRequestUrlIn(`opened ${url} thanks`)).toBe(url)
})
