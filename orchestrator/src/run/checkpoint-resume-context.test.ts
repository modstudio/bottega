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
    }),
  ).toBe('CHECKPOINT RESUME\n' + 'Resume at checkpoint-sha on DEV-970-resume-tip (checkpoint #2).')
})
