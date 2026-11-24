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

test('Docker executable guard stays synchronized after a template substitution', () => {
  expect(
    dockerExecutableLiteralBypasses("const a = `x${y}z`\nconst b = 'docker'", 'fixture.ts'),
  ).toEqual(['fixture.ts:2: Docker executable literals must use DOCKER_EXECUTABLE'])
})

test('Docker executable guard stays synchronized after a regex literal', () => {
  expect(
    dockerExecutableLiteralBypasses("const a = /x/\nconst b = 'docker'", 'fixture.ts'),
  ).toEqual(['fixture.ts:2: Docker executable literals must use DOCKER_EXECUTABLE'])
})

test('Docker executable leaf is the guard exemption', () => {
  expect(
    dockerExecutableLiteralBypasses(
      `export const DOCKER_EXECUTABLE = 'docker'`,
      'orchestrator/src/resources/docker-executable.ts',
    ),
  ).toEqual([])
})
