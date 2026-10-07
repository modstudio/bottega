import { describe, expect, test } from 'bun:test'
import { grokAskCommandFromConfig } from './ask-configuration.ts'

describe('configured Grok ask command', () => {
  test('reads the existing table rather than computing a replacement', () => {
    expect(
      grokAskCommandFromConfig(
        'model = "grok"\n[mcp_servers.orch-ask]\ncommand = "/stale/bun"\n' +
          'args = ["/stale/orch.ts", "ask-server"]\n[ui]\nnotifications = true\n',
      ),
    ).toEqual(['/stale/bun', '/stale/orch.ts', 'ask-server'])
  })
})
