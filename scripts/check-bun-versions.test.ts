import { expect, test } from 'bun:test'
import { bunImagePins, decideBunVersions } from './check-bun-versions.ts'

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
