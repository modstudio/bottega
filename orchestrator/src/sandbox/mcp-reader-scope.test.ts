import { expect, test } from 'bun:test'
import { projectReaderServerNames } from './mcp-reader-scope.ts'

test('a reader proxy is synthesized only for servers the configuration names', () => {
  const configured = ['starship', 'stopal', 'orch']

  // A project whose checkout never configures its primary gets no proxy for it:
  // that name is the platform's own server, installed separately, and a reader
  // proxy rendered for a name `.mcp.json` does not define exits at start.
  expect(projectReaderServerNames(['starship', 'stopal'], undefined, 'orch')).toEqual([
    'starship',
    'stopal',
  ])

  // A configured primary keeps its proxy, even when the allow-list disables it.
  expect(projectReaderServerNames(configured, ['starship'], 'orch')).toEqual(['starship', 'orch'])
  expect(projectReaderServerNames(configured, undefined, 'orch')).toEqual(configured)
})
