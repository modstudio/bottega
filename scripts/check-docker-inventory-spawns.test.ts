import { expect, test } from 'bun:test'
import { dockerExecutableLiteralBypasses } from './check-docker-inventory-spawns.ts'

test('Docker executable guard refuses every literal quote style outside the leaf', () => {
  const sources = [
    `Bun.${'spawnSync'}(['docker', 'ps'])`,
    `Bun.${'spawnSync'}(["docker", "ps"])`,
    `Bun.${'spawnSync'}([\`docker\`, \`ps\`])`,
  ]
  expect(sources.map((source) => dockerExecutableLiteralBypasses(source, 'fixture.ts'))).toEqual([
    ['fixture.ts:1: Docker executable literals must use DOCKER_EXECUTABLE'],
    ['fixture.ts:1: Docker executable literals must use DOCKER_EXECUTABLE'],
    ['fixture.ts:1: Docker executable literals must use DOCKER_EXECUTABLE'],
  ])
})

test('Docker executable guard ignores comments', () => {
  expect(
    dockerExecutableLiteralBypasses(
      `// Bun.${'spawnSync'}(['docker', 'ps'])`,
      'orchestrator/src/failure/failure.ts',
    ),
  ).toEqual([])
})

test('Docker executable leaf is the guard exemption', () => {
  expect(
    dockerExecutableLiteralBypasses(
      `export const DOCKER_EXECUTABLE = 'docker'`,
      'orchestrator/src/resources/docker-executable.ts',
    ),
  ).toEqual([])
})
