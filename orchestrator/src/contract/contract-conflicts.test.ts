import { describe, expect, test } from 'bun:test'
import { contractConflicts } from './contract.ts'

describe('job contracts are visible before submission', () => {
  test.each([
    ['Kept separate rather than merged', false],
    ['reset the counter', false],
    ['merging two lists', false],
    ['merge the two lists', false],
    ['push the branch', true],
    ['merge into main', true],
    ['rebase onto trunk', true],
    ['git reset --hard', true],
    ['amend the commit', true],
    ['3. QUEUED — open, not started. Kept separate from in progress rather than merged.', false],
    ['push the fix', true],
    // merge is the most polysemous of the five; first-word merge is an accepted miss
    ['merge this when done', false],
    ['rebase before you finish', true],
    ['amend the previous change', true],
    ['the main loop resets state', false],
    ['the branch of the decision tree merges', false],
    ['in the main function, merge the maps', false],
    ['open a PR and merge it', true],
    ['merge into the main branch', true],
    ['merge from main', false],
    ['The merge-pr and promote-release steps refuse post-merge evidence.', false],
    ['the merge-pr step waits for checks', false],
    ["run `git push` only in the architect's step", false],
    ['the pre-push hook refuses it', false],
    ['force-push the branch', true],
    ['force-pushed the branch', true],
    ['force-pushing the branch', true],
  ] as const)('git-sense conflict %j fires=%s', (line, fires) => {
    expect(contractConflicts(line)).toEqual(fires ? [{ line: 1, text: line }] : [])
  })
  test('repeating the contract prohibitions is not reported as a conflict', () => {
    expect(
      contractConflicts(
        [
          'Do not commit, push, or merge.',
          'Never push this branch.',
          'Make the change without committing it.',
          'There must be no commits.',
        ].join('\n'),
      ),
    ).toEqual([])
  })
  test('a prohibition does not hide a conflicting instruction later on its line', () => {
    expect(contractConflicts('Do not commit. Push the branch instead.')).toEqual([
      { line: 1, text: 'Do not commit. Push the branch instead.' },
    ])
  })
  test('a lowercase or preposition continuation joins the previous clause', () => {
    expect(contractConflicts('Push it\nto the remote')).toEqual([{ line: 1, text: 'Push it' }])
  })
})
