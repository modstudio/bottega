#!/usr/bin/env python3
"""Stop hook: a delegated run nobody judged teaches the router nothing.

Scoring is the only thing in this system that measures whether delegation is
working. It is also the step most easily skipped, because the answer has already
arrived and been used by the time it is due. So this surfaces the session's own
unscored runs before it finishes.

Only runs THIS session made are raised. Nobody else can judge them: nobody else
read the output.
"""
import json, os, sqlite3, sys

DB = os.environ.get("ORCH_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "orch.db"
)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(f"orch: hook payload could not be parsed ({e.__class__.__name__}: {e})", file=sys.stderr)
        return 0

    # Never loop: if this hook already asked once and Claude is stopping again,
    # let it go rather than trapping the session.
    if payload.get("stop_hook_active"):
        return 0

    # The payload's own session_id first, then the env var Claude always sets.
    #
    # This used to read CLAUDE_CODE_BRIDGE_SESSION_ID, which exists only while
    # Remote Control is connected and is SHARED across sessions on that bridge,
    # falling back to CLAUDE_SESSION_ID, which does not exist at all. So the
    # reminder either stood down entirely, or raised another session's runs —
    # and a session told it is blocking on runs it never read will eventually
    # score them, which is the one thing this file exists to prevent.
    sid = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not sid or not os.path.exists(DB):
        return 0

    try:
        # A timeout, because a fan-out holding the write lock would otherwise
        # stall Stop until Claude's own 600s hook deadline.
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
        rows = con.execute(
            """SELECT r.id, r.agent, r.job, substr(COALESCE(r.label, r.prompt_head), 1, 60)
                 FROM run r LEFT JOIN score s ON s.run_id = r.id
                WHERE r.session_id = ? AND r.status = 'ok'
                  -- A probe is excluded from routing and reporting by design, so
                  -- scoring one teaches the router nothing - which is this hook's
                  -- own reason for existing. Demanding it is friction with no payoff.
                  AND COALESCE(r.probe, 0) = 0
                  -- A CONVERSATION IS ONE UNIT OF WORK. A worker that stopped to ask
                  -- a design question produces one row per turn, and only the root is
                  -- the thing anybody judged: `orch score` refuses a child outright,
                  -- naming the root instead.
                  --
                  -- This predicate is a SECOND COPY of db.ts's UNSCORED_WHERE, in a
                  -- language that cannot import it, and it did exactly what a second
                  -- copy always does - the TypeScript one learned about turns and this
                  -- one did not, so the hook spent a session demanding verdicts on two
                  -- runs that `orch score` would refuse to take. The same failure this
                  -- canon already records for the router and the dashboard drifting
                  -- apart on what a score was.
                  AND r.parent_run_id IS NULL
                  -- A resumed root is not judgeable while its newest turn is
                  -- still running. Raising it now asks for a score the CLI
                  -- correctly cannot accept yet, teaching people to ignore
                  -- the reminder when it fires.
                  AND COALESCE((SELECT c.status FROM run c WHERE c.parent_run_id = r.id
                                 ORDER BY c.turn DESC LIMIT 1), r.status) <> 'running'
                  -- Never scored, OR scored before the conversation moved on.
                  -- A chain takes one verdict, so a root judged after its first
                  -- turn keeps that verdict while a later turn drifts — the
                  -- earliest turn winning by accident. Scores are already
                  -- mutable; what was missing was asking again.
                  AND (s.delivery IS NULL
                       OR s.scored_at < (SELECT MAX(COALESCE(c.started_at, ''))
                                           FROM run c WHERE c.parent_run_id = r.id))
                ORDER BY r.id""",
            (sid,),
        ).fetchall()
        con.close()
    except sqlite3.Error:
        return 0  # never block a session because of a database problem

    if not rows:
        return 0

    # A writing job takes a THIRD axis, and printing the two-axis form for one
    # is how a session came to run a command orch then rejected. The hook cannot
    # import the job table (it is TypeScript), so the jobs that write are named
    # here — and the reminder is generated from the same list rather than a
    # fixed string, so adding one means adding it here too.
    WRITING_JOBS = {"implement", "fix"}
    lines = []
    for i, a, j, p in rows:
        axes = "<none|partial|full> [wrong|mixed|right]"
        if j in WRITING_JOBS:
            axes += " [drifted|partial|faithful]"
        lines.append(f'  orch score {i} {axes} --note "..."   # {a}/{j}  {p}')
    print(json.dumps({
        "decision": "block",
        "reason": (
            f"{len(rows)} delegated run{'s' if len(rows) > 1 else ''} from this session "
            f"{'have' if len(rows) > 1 else 'has'} not been scored:\n\n" + "\n".join(lines) + "\n\n"
            "Score each one from what you actually saw in its output. An unscored run "
            "teaches the router nothing; a guessed score teaches it something false. "
            "If a run's output was never used, score it honestly on whether it answered "
            "the question, then continue."
        ),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
