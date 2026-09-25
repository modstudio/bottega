# ops

Unattended daily maintenance for the machine, run by `launchd`.

| Job | When | What |
|-----|------|------|
| Homebrew upgrade | 06:00 | `brew update`, `upgrade`, then `cleanup`, non-interactively |
| Projects refresh | 06:30 | each project's own `scripts/sync/main` |
| Local model tunnel | always, when configured | SSH local forwarding, kept alive |
| Record tunnel | always, when configured | Fly Postgres local proxy, kept alive |
| Orch monitor | every 4 hours (provisional) | record and report stuck operational state |
| Orch canon eval | 07:00 | behavioral canon probes (`orch canon eval`), routing-neutral |

None has a TTY, so interactive prompts are skipped. If the machine is asleep at
the scheduled time, launchd runs the job on the next wake.

## What the refresh covers

Every registered project whose checkout has `scripts/sync/main`.

**Worktrees are not touched.** Parallel work lives in each repo's
`.claude/worktrees`, and each worktree belongs to one task and one session. A
scheduled job mutating them behind the author's back would destroy more than it
fixed.

**Depth is asked, not assumed.** Each project gets the deepest refresh its own
`scripts/sync/main` advertises: `--full`, else `--refresh`, else flag-less.
Detection reads the script, so a project that gains `--full` is picked up with
no change here.

Exit codes from `scripts/sync/main` are honored: `0` ok, `2` nothing enabled,
`3` needs first-time setup, anything else a failure. One project failing never
aborts the rest.

## The local model tunnel

Set `model_host.ssh_alias` in machine config to an SSH config alias before running
`./install.sh` to install `com.user.local-model-tunnel`. When the key is unset, installation
skips that job and prints that it was skipped.

The launchd job forwards a local port to a model server bound to localhost on
the remote host. `KeepAlive` restarts it when the link drops, and
`ThrottleInterval` prevents a tight respawn loop while the host is unreachable.
Binding the server to localhost keeps an unauthenticated inference endpoint off
routable networks.

The template uses a dedicated key at `~/.ssh/local-model-tunnel`, with
`IdentitiesOnly=yes` and `IdentityAgent=none`, so the unattended job does not
depend on an interactive signing agent. Restrict that key on the remote end to
the one required port forward and no commands. Facts about a particular host,
key restriction or network belong in machine docs:

```
orch doc list --scope machine
```

`ORCH_MODEL_HOST_URL` and `ORCH_MODEL_HOST_MODEL` must be available to
non-interactive shells, because that is how `orch` runs.

## Docker preflight

A project's `--refresh` may run composer, npm and migrations inside containers,
so the daemon must be up. The script launches Docker Desktop and waits up to
120s before starting. If it still cannot come up, those instances log a failure
and the run continues rather than aborting everything.

## Layout

```
ops/
|-- bin/
|   |-- lib-logrotate.sh
|   |-- brew-auto-upgrade.sh
|   `-- projects-morning-refresh.sh
|-- launchd/*.plist.template
`-- install.sh
```

**Location-independent.** Templates carry placeholders that `install.sh`
renders with this checkout's real paths and configuration, writing into
`~/Library/LaunchAgents`. Scripts resolve their own directory, so nothing
hard-codes a path. Edit a template or script, then re-run `./install.sh`; it is
idempotent.

## Logs

Dated, pruned after 30 days:

```
~/Library/Logs/brew-upgrade/YYYY-MM-DD.log
~/Library/Logs/projects-refresh/YYYY-MM-DD.log
```

A small `launchd.log` in each directory captures launch-level failures only,
where the script could not start at all.

## Operating it

```bash
./install.sh
launchctl kickstart -k gui/$(id -u)/com.user.projects-morning-refresh
launchctl bootout gui/$(id -u)/com.user.projects-morning-refresh
```

Change a schedule by editing `StartCalendarInterval` in the relevant template,
then re-running `./install.sh`.
