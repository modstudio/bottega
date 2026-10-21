import { dirname, normalize } from 'node:path'
import type { ArchitectureModule } from './architecture.ts'

const module = (file: string, allowed: string[]): ArchitectureModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const focusedTestModules: ArchitectureModule[] = [
  module('orchestrator/src/focused-test/focused-test-decision.ts', ['node:path']),
  module('orchestrator/src/focused-test/focused-test-paths.ts', [
    'node:fs',
    'node:path',
    './focused-test-decision.ts',
  ]),
  module('orchestrator/src/focused-test/focused-test-files.ts', [
    'node:fs',
    '../no-follow-file.ts',
  ]),
  module('orchestrator/src/focused-test/focused-test-request.ts', [
    'node:crypto',
    'node:fs',
    'node:path',
    '../gate/gate-decision.ts',
    '../run/run-artifacts.ts',
    './focused-test-decision.ts',
    './focused-test-files.ts',
  ]),
  module('orchestrator/src/focused-test/focused-test-tool.ts', [
    '@modelcontextprotocol/server',
    'zod',
    '../run/run-artifacts.ts',
    './focused-test-request.ts',
    './focused-test-service.ts',
  ]),
  module('orchestrator/src/focused-test/focused-test-service.ts', [
    '../ask/worker-auth.ts',
    '../database/db.ts',
    '../jobs/jobs.ts',
    './focused-test-decision.ts',
  ]),
  module('orchestrator/src/focused-test/focused-test-broker.ts', [
    'node:child_process',
    'node:fs',
    'node:path',
    '../database/db.ts',
    '../events.ts',
    '../gate-load.ts',
    '../gate/gate-decision.ts',
    '../gate/host-slot-wait.ts',
    '../idle-kill.ts',
    '../issue/issue-shell.ts',
    '../no-follow-file.ts',
    '../project/project-settings.ts',
    '../resources/main-stack.ts',
    '../run/run-child-priority.ts',
    './focused-test-decision.ts',
    './focused-test-files.ts',
    './focused-test-paths.ts',
    './focused-test-request.ts',
  ]),
]
