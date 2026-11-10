import { expect, test } from 'bun:test'
import { recordModerationClient } from './record-api-client-moderation.ts'
import { recordOutsideBlockClient } from './record-api-client-outside-block.ts'
import { recordOutsideIntakeClient } from './record-api-client-outside-intake.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'
import { recordRunClient } from './record-api-client-run.ts'

test('space administration and run writes carry their resolved destinations', async () => {
  const calls: Array<{ path: string; destination?: string }> = []
  const request = (async (path: string, init = {}) => {
    calls.push({
      path,
      destination: (init as { destinationSpaceId?: string }).destinationSpaceId,
    })
    return {}
  }) as RecordClientRequest
  const destination = 'named-space'
  const intake = recordOutsideIntakeClient(request)
  const blocks = recordOutsideBlockClient(request)
  const moderation = recordModerationClient(request)
  const runs = recordRunClient(request)

  await intake.setOutsideIntake('fixture', destination)
  await intake.pauseOutsideIntake(2, destination)
  await intake.resumeOutsideIntake(destination)
  await blocks.blockOutsideAuthor({ message: 'message-a' }, destination)
  await blocks.unblockOutsideAuthor('user-a', destination)
  await moderation.hideRow({ message: 'message-a', reason: 'spam' }, destination)
  await moderation.unhideRow({ message: 'message-a' }, destination)
  const projectDestination = { spaceId: 'project-space' }
  await runs.putScore('run-a', { delivery: 'full' } as never, projectDestination)
  await runs.voidRun('run-a', { reason: 'duplicate' }, projectDestination)
  await runs.unvoidRun('run-a', { note: 'restored' }, projectDestination)
  await expect(
    runs.putScore('run-b', { delivery: 'full' } as never, {
      refused: 'undeclared-project',
      remedy: 'project fixture has no declared record space',
    }),
  ).rejects.toThrow('project fixture has no declared record space')

  expect(calls).toEqual([
    { path: '/v1/outside-intake', destination },
    { path: '/v1/outside-intake/pause', destination },
    { path: '/v1/outside-intake/resume', destination },
    { path: '/v1/outside-blocks', destination },
    { path: '/v1/outside-blocks/user-a', destination },
    { path: '/v1/moderation/hide', destination },
    { path: '/v1/moderation/unhide', destination },
    { path: '/v1/runs/run-a/score', destination: 'project-space' },
    { path: '/v1/runs/run-a/void', destination: 'project-space' },
    { path: '/v1/runs/run-a/unvoid', destination: 'project-space' },
  ])
})
