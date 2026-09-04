# ops

The machine's own upkeep. Runs unattended under launchd, which is the whole
design constraint: nobody is watching, so it must fail loudly in the log and
never take a destructive guess.

- `bin/projects-morning-refresh.sh` — 06:30 daily. Refreshes the **main
  checkout** of each family and nothing else.
- `launchd/` — templates, installed location-independently by `install.sh`.
  Brew upkeep at 06:00, project refresh at 06:30.
- `com.user.orch-monitor` — a provisional four-hour operational-state
  backstop. Its queryable record lives in orch.db; launchd output is only a
  process log.

**Depth is asked, not assumed.** Each project gets the deepest refresh its own
`scripts/sync/main` advertises — `--full`, else `--refresh`, else flag-less.
Detection reads the script, so a project that gains `--full` is picked up with
no change here. The previous per-project list went stale exactly this way.

**Worktrees are never touched**, and that is deliberate rather than an
oversight.

One project failing never aborts the rest.
