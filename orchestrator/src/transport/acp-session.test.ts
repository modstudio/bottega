import { expect, test } from 'bun:test'
import { type AcpSessionConnection, establishAcpSession } from './acp-session.ts'

test('an ACP continuation loads its recorded session id', async () => {
  const loaded: string[] = []
  const connection: AcpSessionConnection = {
    async loadSession(input) {
      loaded.push(input.sessionId)
    },
    async newSession() {
      throw new Error('must not create a new session')
    },
  }
  const result = await establishAcpSession({
    connection,
    cwd: '/worktree',
    mcpServers: [],
    sessionId: 'vendor-session',
    fallbackToNew: true,
  })
  expect(loaded).toEqual(['vendor-session'])
  expect(result).toMatchObject({ sessionId: 'vendor-session', loaded: true })
})

test('a load failure records its reason and falls back to a fresh session', async () => {
  const warnings: string[] = []
  const connection: AcpSessionConnection = {
    async loadSession() {
      throw new Error('saved session is gone')
    },
    async newSession() {
      return { sessionId: 'fresh-session' }
    },
  }
  const result = await establishAcpSession({
    connection,
    cwd: '/worktree',
    mcpServers: [],
    sessionId: 'missing-session',
    fallbackToNew: true,
    onLoadFailure: (reason) => warnings.push(reason),
  })
  expect(result).toMatchObject({ sessionId: 'fresh-session', loaded: false })
  expect(warnings).toEqual(['saved session is gone'])
})
