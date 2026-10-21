import { describe, expect, test } from 'bun:test'
import { type DockerWorkspaceInputs, decideDockerWorkspaces } from './check-docker-workspaces.ts'

const workspaces = ['alpha', 'nested/beta']
const completeDockerfile = `
FROM oven/bun
COPY package.json bun.lock ./
COPY alpha/package.json alpha/package.json
COPY nested/beta/package.json nested/beta/package.json
RUN bun install --frozen-lockfile
COPY . .
`
const completeIgnore = `
*
!alpha/package.json
!nested/beta/package.json
`

function inputs(overrides: Partial<DockerWorkspaceInputs> = {}): DockerWorkspaceInputs {
  return {
    workspaces,
    dockerfiles: [{ path: 'deploy/Dockerfile', text: completeDockerfile }],
    dockerignore: completeIgnore,
    ...overrides,
  }
}

describe('docker workspace decision', () => {
  test('refuses a Dockerfile missing one workspace before install', () => {
    const text = completeDockerfile
      .replace('COPY nested/beta/package.json nested/beta/package.json\n', '')
      .replace(
        'RUN bun install --frozen-lockfile\n',
        'RUN bun install --frozen-lockfile\nCOPY nested/beta/package.json nested/beta/package.json\n',
      )
    expect(
      decideDockerWorkspaces(inputs({ dockerfiles: [{ path: 'deploy/Dockerfile', text }] })),
    ).toEqual([
      'deploy/Dockerfile: missing workspace nested/beta; add before bun install: COPY nested/beta/package.json nested/beta/package.json',
    ])
  })

  test('refuses an allowlist missing one workspace', () => {
    expect(
      decideDockerWorkspaces(
        inputs({ dockerignore: completeIgnore.replace('!nested/beta/package.json\n', '') }),
      ),
    ).toEqual(['.dockerignore: missing workspace nested/beta; add: !nested/beta/package.json'])
  })

  test('refuses a later stage missing a workspace copied only in the first stage', () => {
    const text = `${completeDockerfile}
FROM oven/bun
COPY alpha/package.json alpha/package.json
RUN bun install --frozen-lockfile
`
    expect(
      decideDockerWorkspaces(inputs({ dockerfiles: [{ path: 'deploy/Dockerfile', text }] })),
    ).toEqual([
      'deploy/Dockerfile:11: missing workspace nested/beta; add before bun install: COPY nested/beta/package.json nested/beta/package.json',
    ])
  })
})
