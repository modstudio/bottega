# Getting started

Bottega sits beneath the coding harness you already use. You design and decide
in the harness; Bottega sends the building to an external agent in its own
worktree, brings every judgment call back to you, and records what came back.

This page takes a fresh machine to a first delegated change.

## What you need

- macOS or Linux, with `git`. Linux also requires `ripgrep`, `bubblewrap` and
  `socat`, and must permit unprivileged user namespaces for the sandbox.
- The installer requires `curl` or `wget`, `tar`, and `sha256sum` or `shasum`.
  Building from a checkout also requires Bun.
- One agent CLI that Bottega can drive, installed and signed in: `codex` or
  `grok`. Bottega detects them; it never installs or signs in for you.
- `gh`, signed in, if you want Bottega to open pull requests.

No tracker and no hosted account are required. Tasks and the project register
live in a local store.

## Install

    curl -fsSL https://raw.githubusercontent.com/modstudio/bottega/main/install.sh | sh

The installer downloads one verified binary for your platform into
`~/.local/bin` and links `orch` and `hub` to it. It prints the line to add when
that directory is not on your `PATH`.

To work from a checkout instead, build the binary for your platform:

    bun install
    bun run release:binary -- v0.0.0 ./out darwin-arm64

## Set up

Run setup from the folder that holds your repositories, or name folders with
`--in`:

    bottega setup

Setup inspects the machine and each repository, then asks one question per
screen with a recommendation preselected: which harnesses should get the
Bottega MCP server, whether to replace a registration that differs, which task
key prefix each project uses, whether a detected trunk disagreement should be
settled, and whether to write a starter worktree recipe. It shows the changes
and applies them after one confirmation. Run it again at any time; matching
configuration is left alone.

Setup also lists what it could not do for you, each with the command that fixes
it. On a new machine expect one for each agent:

    orch agent probe codex

The probe runs the agent once to prove it can read a repository and return a
structured reply. An agent takes repository work only after it passes.
`orch agents` shows where each one stands.

## Delegate a first change

Create a task. The key it prints goes on the branch and the commit.

    hub task new --project demo --title "Add a health endpoint"

Hand the task to an agent with a specification of what to build:

    orch do implement --key DEMO-1 --cwd ~/code/demo "Add GET /health returning 200 and the text ok, with a test."

The run happens in a disposable worktree of that repository; your checkout is
not touched. `orch do` prints a run id and returns.

    orch wait 1        # until it finishes or asks
    orch result 1      # what the agent says it did
    orch diff 1        # what it actually changed

The worker's change is on the run's own branch and may include uncommitted work.
Nothing is pushed. Close-out preserves uncommitted changes in the run artifacts.

## Judge it

Say what you got. The verdict is what teaches Bottega which agent to send the
next job of this kind to, so give it only for output you have read.

    orch score 1 full right faithful --note "Endpoint and test as specified."

The three words answer three questions: did anything usable arrive, was it
right, and did it build what the specification asked for. `orch pending` lists
the runs still waiting for your verdict.

## When the agent asks

A worker that reaches a decision the specification did not settle stops instead
of guessing.

    orch inbox                              # the open questions
    orch answer 1 "Return JSON, not text."  # your ruling resumes the same worker

## From your harness

Setup registered Bottega's MCP server in the harnesses you chose. Through it the
harness can run setup for another project and bring you each question a worker
raises, then record your ruling. Dispatching is the same `orch do` command, run
by the harness in its own shell.

Bottega records who dispatched each run and lets only that caller judge it. Runs
you start from a terminal are yours as the operator of this machine. Runs a
Claude Code session starts belong to that session.

## Where to look when something is off

    orch doctor        # the machine, the store, the agents
    orch agents        # which agents are ready and what each needs
    bottega setup      # re-run; it reports what is still missing
