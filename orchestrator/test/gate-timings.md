# Gate timing surface

The orchestrator gate is one `bun test src` invocation under the shared
host-load hold. It preloads the isolated store environment, writes junit and
spawn sidecars while the invocation runs, merges them into
`<state>/orchestrator/runs/gate-timings/<stamp>.json`, and removes the transient
sidecars.

The committed baseline is `scripts/quality/test-timings.json`. It records the
single leg's elapsed time and each source test file's wall time, test count,
and measured Bun spawn count. The timing ratchet only moves the package total
down. `scripts/check-test-spawns.ts` independently refuses any source test file
measured above the fixed limit of 20 spawns.

The current host measurement runs 808 tests across 87 files in about 9 seconds.
There is no subprocess test leg, size class, shard allocation, or retry path.
