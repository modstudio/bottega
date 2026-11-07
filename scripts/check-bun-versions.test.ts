import { expect, test } from 'bun:test'
import {
  bunImagePins,
  decideBunVersionFile,
  decideBunVersions,
  decideRunningBunVersion,
  decideWorkflowBunVersions,
} from './check-bun-versions.ts'

test('refuses a literal workflow Bun version with its location and remedy', () => {
  expect(
    decideWorkflowBunVersions([
      {
        path: '.github/workflows/ci.yml',
        source: 'with:\n  bun-version: 1.4.4\n',
      },
    ]),
  ).toBe(
    'workflow Bun version check failed\n.github/workflows/ci.yml:2: use bun-version-file: .bun-version',
  )
})

test('refuses a setup-bun step that does not read the version file, beside one that does', () => {
  expect(
    decideWorkflowBunVersions([
      {
        path: '.github/workflows/ci.yml',
        source: [
          'jobs:',
          '  first:',
          '    steps:',
          '      - uses: oven-sh/setup-bun@v2',
          '        with:',
          '          bun-version-file: .bun-version',
          '  second:',
          '    steps:',
          '      - uses: oven-sh/setup-bun@v2',
          '      - run: bun install',
          '        with:',
          '          bun-version-file: .bun-version',
        ].join('\n'),
      },
    ]),
  ).toBe(
    'workflow Bun version check failed\n.github/workflows/ci.yml:9: setup-bun must declare bun-version-file: .bun-version',
  )
})

test('refuses an invalid repository Bun version declaration', () => {
  expect(decideBunVersionFile('latest\n')).toBe(
    '.bun-version must contain one plain version, for example 1.4.4',
  )
})

test('warns without refusing when the running Bun version differs', () => {
  expect(decideBunVersionFile('1.4.4\n')).toBeUndefined()
  expect(decideRunningBunVersion('1.4.4', '1.4.3')).toBe(
    'running Bun 1.4.3 differs from .bun-version 1.4.4; install it with curl -fsSL https://bun.com/install | bash -s "bun-v1.4.4", or update .bun-version',
  )
})

test('passes when every deploy image pin agrees with the target', () => {
  expect(
    decideBunVersions('1.4.4', [
      { path: 'hub/deploy/Dockerfile', line: 1, version: '1.4.4' },
      { path: 'orchestrator/deploy/api/Dockerfile', line: 3, version: '1.4.4' },
    ]),
  ).toBeUndefined()
})

test('refuses a Dockerfile pin that differs from the target', () => {
  expect(
    decideBunVersions('1.4.4', [
      { path: 'hub/deploy/Dockerfile', line: 1, version: '1.3.14' },
      { path: 'orchestrator/deploy/api/Dockerfile', line: 3, version: '1.4.4' },
    ]),
  ).toBe(
    'deploy image Bun version check failed\nhub/deploy/Dockerfile:1: Bun 1.3.14\nset every pin to 1.4.4',
  )
})

test('reads every oven/bun FROM form, so no pin drops out of the check', () => {
  const source = [
    'FROM oven/bun:1.4.4-alpine AS build',
    'FROM --platform=linux/amd64 oven/bun:1.3.14',
    'FROM docker.io/oven/bun:1.3.13-slim',
    'FROM oven/bun@sha256:deadbeef',
    'FROM node:22-alpine',
    'RUN echo oven/bun:9.9.9',
  ].join('\n')
  expect(bunImagePins('Dockerfile', source)).toEqual([
    { path: 'Dockerfile', line: 1, version: '1.4.4' },
    { path: 'Dockerfile', line: 2, version: '1.3.14' },
    { path: 'Dockerfile', line: 3, version: '1.3.13' },
    { path: 'Dockerfile', line: 4, version: 'no version tag' },
  ])
})
