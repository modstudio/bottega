import { expect, test } from 'bun:test'
import { releaseHostedRowsAndRetireDefaultProject } from './machine-update-retirement.ts'

test('post-update cleanup retires after hosted-row release when bound or signed in', async () => {
  for (const eligibility of [
    { attached: true, session: false },
    { attached: false, session: true },
  ]) {
    const events: string[] = []
    const lines: string[] = []
    await releaseHostedRowsAndRetireDefaultProject(
      { log: (line) => lines.push(line) },
      {
        releaseHostedRows: async () => {
          events.push('release')
        },
        storeAttachedToHostedRecord: () => eligibility.attached,
        recordSessionPresent: () => eligibility.session,
        retireDefaultLocalProject: async () => {
          events.push('retire')
          return true
        },
      },
    )
    expect(events).toEqual(['release', 'retire'])
    expect(lines).toEqual(['retired unused default local project tasks'])
  }
})

test('post-update cleanup skips retirement without a binding or record session', async () => {
  let retirements = 0
  await releaseHostedRowsAndRetireDefaultProject(
    { log: () => {} },
    {
      releaseHostedRows: async () => {},
      storeAttachedToHostedRecord: () => false,
      recordSessionPresent: () => false,
      retireDefaultLocalProject: async () => {
        retirements += 1
        return false
      },
    },
  )
  expect(retirements).toBe(0)
})

test('post-update cleanup logs a retirement failure and remains successful', async () => {
  const lines: string[] = []
  await expect(
    releaseHostedRowsAndRetireDefaultProject(
      { log: (line) => lines.push(line) },
      {
        releaseHostedRows: async () => {},
        storeAttachedToHostedRecord: () => true,
        recordSessionPresent: () => false,
        retireDefaultLocalProject: async () => {
          throw new Error('retirement fixture failure')
        },
      },
    ),
  ).resolves.toBeUndefined()
  expect(lines).toEqual(['default local project retirement failed: retirement fixture failure'])
})
