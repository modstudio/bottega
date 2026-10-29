// concern: architecture-manifest
/** Metric module allowlists kept outside the root manifest's file ceiling. */
import { dirname, normalize } from 'node:path'

type MetricModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): MetricModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const metricModules: MetricModule[] = [
  module('orchestrator/src/metric/metric.ts', [
    '../../../shared/file-kind.ts',
    '../../../shared/machine-config.ts',
    '../../../shared/record-id.ts',
    '../database/db.ts',
    '../git/git-environment.ts',
    '../project/projects.ts',
    './transcript-reader.ts',
  ]),
  module('orchestrator/src/metric/transcript-reader.ts', [
    'node:fs',
    'node:path',
    'node:readline',
    'node:stream',
  ]),
]
