import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pullRequestChangeBase } from './pull-request-change-base.ts'

test('uses the merge ref first parent for a pull request', () => {
  expect(pullRequestChangeBase({}, 'pull_request', true)).toEqual({ revision: 'HEAD^1' })
})

test('refuses a pull request HEAD without a second parent', () => {
  expect(pullRequestChangeBase({}, 'pull_request', false)).toEqual({
    refusal: expect.stringContaining('leaving actions/checkout ref: unset'),
  })
})

test('uses the current merge-group base', () => {
  expect(
    pullRequestChangeBase({ merge_group: { base_sha: 'current-base' } }, 'merge_group', false),
  ).toEqual({ revision: 'current-base' })
})

test('refuses a merge group without its base', () => {
  expect(pullRequestChangeBase({ merge_group: {} }, 'merge_group', false)).toEqual({
    refusal: expect.stringContaining('re-run the merge-queue check'),
  })
})

test('refuses an event that does not describe pull request changes', () => {
  expect(pullRequestChangeBase({}, 'push', false)).toEqual({
    refusal: expect.stringContaining('gate this step on pull_request and merge_group events'),
  })
})

test('all CI pull request change comparisons use the shared base decision', () => {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const helper = 'scripts/pull-request-change-base.ts'
  const workflowDirectory = resolve(root, '.github/workflows')
  const workflowPaths = readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
    .map((entry) => resolve(workflowDirectory, entry.name))
  const scriptPaths = readdirSync(resolve(root, 'scripts'), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => resolve(entry.parentPath, entry.name))
  const forbidden = [
    /pull_request\.base\.sha/,
    /pull_request\?\.base\?\.sha/,
    /merge_group\.base_sha/,
    /merge_group\?\.base_sha/,
  ]
  const findings = [...workflowPaths, ...scriptPaths].flatMap((path) => {
    const repositoryPath = relative(root, path)
    if (repositoryPath === helper) return []
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) =>
        forbidden.some((pattern) => pattern.test(line)) ? [`${repositoryPath}:${index + 1}`] : [],
      )
  })

  expect(findings).toEqual([])
})
