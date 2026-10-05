// concern: architecture-manifest
/** Board module allowlists, kept beside the root manifest so it stays within its file ceiling. */
import { dirname, normalize } from 'node:path'

type BoardModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): BoardModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const boardModules: BoardModule[] = [
  module('orchestrator/src/board/board-policy.ts', []),
  module('orchestrator/src/board/board-tags.ts', ['node:path']),
  module('orchestrator/src/board/board-routing.ts', ['./board-tags.ts']),
  module('orchestrator/src/board/board-context.ts', [
    'bun:sqlite',
    '../database/db.ts',
    './board-routing.ts',
  ]),
  module('orchestrator/src/board/board-render.ts', ['./board-policy.ts', './board-tags.ts']),
  module('orchestrator/src/board/board-thread-policy.ts', ['./board-policy.ts']),
  module('orchestrator/src/board/board-thread-render.ts', ['./board-policy.ts']),
  module('orchestrator/src/board/board-answer-note.ts', ['../mcp/hub-notes.ts']),
  module('orchestrator/src/board/board-store.ts', [
    'node:os',
    '../../../shared/secret-shaped.ts',
    '../database/db.ts',
    '../project/projects.ts',
    './board-context.ts',
    './board-policy.ts',
    './board-render.ts',
    './board-routing.ts',
    './board-tags.ts',
  ]),
  module('orchestrator/src/board/board-service.ts', [
    'node:os',
    '../database/db.ts',
    '../project/projects.ts',
    './board-policy.ts',
    './board-render.ts',
    './board-store.ts',
    './board-thread-render.ts',
  ]),
  module('orchestrator/src/board/board-thread-service.ts', [
    '../../../shared/secret-shaped.ts',
    '../database/db.ts',
    '../project/projects.ts',
    './board-answer-note.ts',
    './board-policy.ts',
    './board-store.ts',
    './board-thread-policy.ts',
  ]),
  module('orchestrator/src/board/board-suggestions.ts', [
    '../../../shared/secret-shaped.ts',
    '../database/db.ts',
    './board-policy.ts',
    './board-service.ts',
    './board-tags.ts',
  ]),
  module('orchestrator/src/board/board-commands.ts', [
    'commander',
    './board-service.ts',
    './board-suggestions.ts',
    './board-thread-service.ts',
  ]),
  module('orchestrator/src/ask/ask-board-tools.ts', [
    '@modelcontextprotocol/server',
    'zod',
    '../board/board-policy.ts',
    '../board/board-suggestions.ts',
  ]),
  module('orchestrator/src/run/run-board-prompt.ts', [
    'node:fs',
    '../board/board-service.ts',
    '../database/db.ts',
    './run-process.ts',
  ]),
]
