import { describe, expect, test } from 'bun:test'
import { categorizeFile } from './file-kind.ts'

describe('categorizeFile', () => {
  test.each([
    ['orchestrator/src/doc/docs.ts', 'product'],
    ['hub/web/src/docs/page.tsx', 'product'],
    ['orchestrator/src/doc/docs-core.test.ts', 'test'],
    ['orchestrator/hooks/test_score_reminder.py', 'test'],
    ['orchestrator/hooks/process_heartbeat_shell.py', 'test'],
    ['orchestrator/hooks/heartbeat_decision_fixture.py', 'test'],
    ['orchestrator/hooks/board_hook_common.py', 'product'],
    ['orchestrator/src/process_state.py', 'product'],
    ['docs/guide.txt', 'docs'],
    ['packages/x/docs/notes.txt', 'docs'],
    ['orchestrator/src/doc/README.md', 'docs'],
    ['db/migrations/0001/snapshot.json', 'generated'],
  ] as const)('%s is %s', (path, kind) => {
    expect(categorizeFile(path)).toBe(kind)
  })
})
