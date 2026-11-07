import { expect, test } from 'bun:test'
import {
  readReviewLensInputArtifact,
  successorReviewLensInputStatuses,
  unavailableStatus,
} from './review-lens-input-artifact.ts'

test('a successor carries predecessor statuses through its run options', () => {
  const predecessor = {
    outcome: 'statuses' as const,
    taskTextInput: 'carried' as const,
    rulingsInput: unavailableStatus('comments were unavailable'),
  }

  expect(successorReviewLensInputStatuses(predecessor)).toEqual({
    taskTextInput: 'carried',
    rulingsInput: 'unavailable: comments were unavailable',
  })
})

test('a successor makes an absent predecessor artifact explicitly unavailable', () => {
  expect(successorReviewLensInputStatuses(readReviewLensInputArtifact(null))).toEqual({
    taskTextInput: 'unavailable: input statuses were not carried to this run',
    rulingsInput: 'unavailable: input statuses were not carried to this run',
  })
})
