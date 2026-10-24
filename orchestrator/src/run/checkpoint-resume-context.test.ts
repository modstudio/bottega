import { expect, test } from 'bun:test'
import { renderCheckpointResumeContext } from './checkpoint-resume-context.ts'

const checkpoint = {
  commit_sha: 'checkpoint-sha',
  checkpoint_no: 2,
  task_pointer: 'finished the parser',
}

test('renders a checkpoint that is the continuation start', () => {
  expect(
    renderCheckpointResumeContext({
      startCommit: 'checkpoint-sha',
      branch: 'DEV-970-resume-tip',
      checkpoint,
      recentLog: 'checkpoint-sha checkpoint',
      operation: null,
    }),
  ).toBe(
    'CHECKPOINT RESUME\n' +
      'Resume at checkpoint-sha on DEV-970-resume-tip (checkpoint #2).\n' +
      'Last completed item: finished the parser\n' +
      'Recent branch history:\ncheckpoint-sha checkpoint',
  )
})

test('renders a checkpoint behind the continuation start only as provenance', () => {
  const rendered = renderCheckpointResumeContext({
    startCommit: 'branch-tip-sha',
    branch: 'DEV-970-resume-tip',
    checkpoint,
    recentLog: 'branch-tip-sha worker commit\ncheckpoint-sha checkpoint',
    operation: null,
  })

  expect(rendered).toContain('Resume at branch-tip-sha on DEV-970-resume-tip.')
  expect(rendered).toContain(
    'Latest harness checkpoint #2 at checkpoint-sha is earlier than the start commit and is provenance, not the tree state.',
  )
  expect(rendered).not.toContain('Resume from checkpoint')
})

test('omits absent task pointer and recent history', () => {
  expect(
    renderCheckpointResumeContext({
      startCommit: 'checkpoint-sha',
      branch: 'DEV-970-resume-tip',
      checkpoint: { ...checkpoint, task_pointer: null },
      recentLog: '',
      operation: null,
    }),
  ).toBe('CHECKPOINT RESUME\n' + 'Resume at checkpoint-sha on DEV-970-resume-tip (checkpoint #2).')
})

test('names an in-progress rebase beside a checkpoint row', () => {
  expect(
    renderCheckpointResumeContext({
      startCommit: 'checkpoint-sha',
      branch: 'DEV-1691-sequencer',
      checkpoint,
      recentLog: '',
      operation: { place: 'resumed-tree', kind: 'rebase' },
    }),
  ).toBe(
    'CHECKPOINT RESUME\n' +
      'Resume at checkpoint-sha on DEV-1691-sequencer (checkpoint #2).\n' +
      'A rebase is in progress in this worktree; finish or abort it before you commit.\n' +
      'Last completed item: finished the parser',
  )
})

test('names the retained tree, not this tree, when the turn gets a recreated one', () => {
  const rendered = renderCheckpointResumeContext({
    startCommit: 'branch-tip-sha',
    branch: 'DEV-1691-sequencer',
    checkpoint: null,
    recentLog: '',
    operation: { place: 'retained-tree', kind: 'rebase', path: '/trees/retained-19165' },
  })

  expect(rendered).toBe(
    'CHECKPOINT RESUME\n' +
      "The run's retained tree at /trees/retained-19165 had a rebase in progress; " +
      'this tree starts from the branch tip without it.',
  )
  expect(rendered).not.toContain('in this worktree')
})

test('emits the block for an in-progress rebase with no checkpoint row', () => {
  expect(
    renderCheckpointResumeContext({
      startCommit: null,
      branch: null,
      checkpoint: null,
      recentLog: '',
      operation: { place: 'resumed-tree', kind: 'rebase' },
    }),
  ).toBe(
    'CHECKPOINT RESUME\n' +
      'A rebase is in progress in this worktree; finish or abort it before you commit.',
  )
})

test('emits nothing when a clean worktree has no checkpoint row', () => {
  expect(
    renderCheckpointResumeContext({
      startCommit: null,
      branch: null,
      checkpoint: null,
      recentLog: '',
      operation: null,
    }),
  ).toBeNull()
})
