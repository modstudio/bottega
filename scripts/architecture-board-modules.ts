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
  module('orchestrator/src/board/board-service.ts', [
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
  module('orchestrator/src/board/board-commands.ts', ['commander', './board-service.ts']),
]
