# port

Cross-project feature porting. It finds what changed in one project's
project-management layer and creates tasks to carry it to another.

**It only stages work.** A run creates tasks in the target via that
project's MCP server. It never implements a port.

`state.json` and `refs.json` are a live ledger. Entries point at open
tasks in other projects — last-ported SHAs, skipped features, and the
source commits and paths a pending task was staged from. The skill's own
workflow edits them. They are never hand-rewritten or regenerated.

This is the one concern that legitimately touches other projects' MCP
servers, which is why bottega is the only checkout that registers them all.
