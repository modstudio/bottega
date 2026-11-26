import { describe, expect, test } from 'bun:test'
import { selectReplyArtifactPath } from './note-curator-orch.ts'

describe('curator artifact manifest', () => {
  test('selects the validated reply among diagnostics and other artifacts', () => {
    const manifest = [
      'sandbox: weaker network isolation enabled: no firewall backend',
      '',
      '/tmp/runs/42997/artifacts/prompt.txt',
      '/tmp/runs/42997/artifacts/reply.json',
      '/tmp/runs/42997/artifacts/output.txt',
      'the trailing run output',
    ].join('\n')

    expect(selectReplyArtifactPath(manifest)).toBe('/tmp/runs/42997/artifacts/reply.json')
  })

  test('refuses a manifest without the validated reply', () => {
    expect(() =>
      selectReplyArtifactPath(
        ['/tmp/runs/42997/artifacts/prompt.txt', '/tmp/runs/42997/artifacts/output.txt'].join('\n'),
      ),
    ).toThrow('artifact manifest does not contain artifacts/reply.json')
  })
})
