#!/usr/bin/env python3
"""Stop hook: a delegated run nobody judged teaches the router nothing.

Scoring is the only thing in this system that measures whether delegation is
working. It is also the step most easily skipped, because the answer has already
arrived and been used by the time it is due. So this surfaces the session's own
unscored runs before it finishes.

Only runs THIS session made are raised. Nobody else can judge them: nobody else
read the output.
"""
import json, os, sqlite3, subprocess, sys

DB = os.environ.get("ORCH_DB") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "orch.db"
)


def hub_bin():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    return os.path.join(root, "bin", "hub")


def orch_bin():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    return os.path.join(root, "bin", "orch")


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
    # Remote Control can make the payload identity differ from the shell's.
    # Notes belong to either observed identity, and an acknowledgement by
    # either one suppresses the reminder, so carry the ordered set to hub.
    session_ids = list(dict.fromkeys(filter(None, [
        payload.get("session_id"), os.environ.get("CLAUDE_CODE_SESSION_ID")
    ])))
    sid = session_ids[0] if session_ids else None
    if not sid or not os.path.exists(DB):
        return 0

    try:
        # A timeout, because a fan-out holding the write lock would otherwise
        # stall Stop until Claude's own 600s hook deadline.
        con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=2)
        rows = con.execute(
            """SELECT r.id, r.agent, r.job, substr(COALESCE(r.label, r.prompt_head), 1, 60),
                      s.delivery, s.quality, s.fidelity, review.id,
                      rl.reproduced, rl.coverage, rl.limits, rl.overlap
                 FROM run r LEFT JOIN score s ON s.run_id = r.id
                 LEFT JOIN review_lens rl ON rl.run_id = r.id
                 LEFT JOIN review ON review.id = rl.review_id
                WHERE r.session_id = ? AND r.status = 'ok'
                  AND r.evidence_excluded IS NULL
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
                  AND ((s.delivery IS NULL
                        OR s.scored_at < (SELECT MAX(COALESCE(c.started_at, ''))
                                            FROM run c WHERE c.parent_run_id = r.id))
                       OR (review.id IS NOT NULL AND review.completed_at IS NULL))
                ORDER BY r.id""",
            (sid,),
        ).fetchall()
        pairs = []
        has_compared_pairs = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='compared_pair'"
        ).fetchone()
        if has_compared_pairs:
            pairs = con.execute(
                """SELECT newer.id, older.id, older.agent,
                          CASE
                            WHEN newer.lens IS NOT NULL AND newer_review.patch_id IS NOT NULL
                                 AND older_review.patch_id IS NOT NULL
                              THEN 'same task prompt and lens; same change'
                            WHEN newer.lens IS NOT NULL
                              THEN 'same task prompt and lens; at least one change unrecorded'
                            WHEN newer_review.patch_id IS NOT NULL AND older_review.patch_id IS NOT NULL
                              THEN 'same task prompt; same change'
                            ELSE 'same task prompt; at least one change unrecorded'
                          END,
                          newer.job, newer_score.delivery, newer_score.quality, newer_score.fidelity
                     FROM run newer
                     LEFT JOIN review_lens newer_lens ON newer_lens.run_id = newer.id
                     LEFT JOIN review newer_review ON newer_review.id = newer_lens.review_id
                     JOIN score newer_score ON newer_score.run_id = newer.id
                     JOIN run older ON older.id < newer.id
                      AND older.parent_run_id IS NULL
                      AND older.job = newer.job
                      AND older.session_id = newer.session_id
                      AND COALESCE(older.probe, 0) = 0
                      AND older.evidence_excluded IS NULL
                     LEFT JOIN review_lens older_lens ON older_lens.run_id = older.id
                     LEFT JOIN review older_review ON older_review.id = older_lens.review_id
                     JOIN score older_score ON older_score.run_id = older.id
                     LEFT JOIN compared_pair compared
                       ON compared.run_a_id = older.id AND compared.run_b_id = newer.id
                    WHERE newer.parent_run_id IS NULL AND newer.session_id = ?
                      AND COALESCE(newer.probe, 0) = 0
                      AND newer.evidence_excluded IS NULL
                      AND newer.spec_sha IS NOT NULL
                      AND older.spec_sha = newer.spec_sha
                      AND (newer.lens IS older.lens)
                      AND newer_review.patch_id IS older_review.patch_id
                      AND newer_review.path_set IS older_review.path_set
                      AND datetime(newer_score.scored_at) >= datetime('now', '-24 hours')
                      AND datetime(older_score.scored_at) >= datetime('now', '-24 hours')
                      AND compared.run_a_id IS NULL
                    ORDER BY newer.id, older.id""",
                (sid,),
            ).fetchall()
        cleanup_roots = con.execute(
            """SELECT MIN(id)
                 FROM run
                WHERE session_id IN ({}) AND worktree IS NOT NULL
                  AND status IN ('ok','failed','stale','stopped')
                GROUP BY worktree ORDER BY 1""".format(",".join("?" for _ in session_ids)),
            session_ids,
        ).fetchall()
    except sqlite3.Error:
        return 0  # never block a session because of a database problem

    cleanup_holds = []
    for (root_id,) in cleanup_roots:
        try:
            result = subprocess.run(
                [orch_bin(), "close-out", str(root_id)], capture_output=True,
                text=True, timeout=300,
            )
            report = (result.stdout or result.stderr).strip()
            if report.startswith("held "):
                cleanup_holds.append(report)
        except Exception:
            # Close-out failures surface through monitor; Stop blocks only for
            # irreplaceable work that close-out positively classified HELD.
            pass

    notes = []
    try:
        note_args = [hub_bin(), "note", "list"]
        for session_id in session_ids:
            note_args.extend(["--session", session_id])
        note_args.extend(["--actionable", "--json"])
        result = subprocess.run(
            note_args,
            capture_output=True, text=True, timeout=5, check=True,
        )
        notes = [(row["id"], row["project"], row["text"]) for row in json.loads(result.stdout)]
    except Exception:
        notes = []

    if not rows and not pairs and not notes and not cleanup_holds:
        return 0

    # A writing job takes a THIRD axis, and printing the two-axis form for one
    # is how a session came to run a command orch then rejected. The hook cannot
    # import the job table (it is TypeScript), so the jobs that write are named
    # here — and the reminder is generated from the same list rather than a
    # fixed string, so adding one means adding it here too.
    WRITING_JOBS = {"implement", "fix"}
    lines = []
    pairs_by_run = {}
    for current, partner, agent, reason, pair_job, pair_delivery, pair_quality, pair_fidelity in pairs:
        entry = pairs_by_run.setdefault(current, {
            "job": pair_job, "delivery": pair_delivery, "quality": pair_quality,
            "fidelity": pair_fidelity, "partners": [],
        })
        entry["partners"].append((partner, agent, reason))
    for i, a, j, p, delivery, quality, fidelity, review_id, reproduced, coverage, limits, overlap in rows:
        axes = delivery or "<none|partial|full>"
        if delivery is None or delivery != "none":
            axes += " " + (quality or "<wrong|mixed|right>")
        if j in WRITING_JOBS:
            axes += " " + (fidelity or "<drifted|partial|faithful>")
        missing = []
        if review_id is not None:
            for name, value, choices in [
                ("reproduced", reproduced, "none|some|all"),
                ("coverage", coverage, "empty|partial|adequate"),
                ("limits", limits, "named|absent"),
                ("overlap", overlap, "unique|shared|none|alone"),
            ]:
                if value is None:
                    missing.append(f"--{name} <{choices}>")
            ordinals = con.execute(
                "SELECT ordinal FROM review_finding WHERE review_id=? AND disposition IS NULL ORDER BY ordinal",
                (review_id,),
            ).fetchall()
            missing.extend(
                f"--finding {ordinal}=<disposition>:<severity-or-category>"
                for (ordinal,) in ordinals
            )
        pair_entry = pairs_by_run.pop(i, None)
        run_pairs = pair_entry["partners"] if pair_entry else []
        if run_pairs:
            ids = ",".join(str(partner) for partner, _, _ in run_pairs)
            missing.append(f"--better-than {ids} | --worse-than {ids} | --same-as {ids}")
        suffix = "  rescore" if delivery is not None else ""
        lines.append(
            f'  orch judge {i} {axes} {" ".join(missing)} --note "..."   # {a}/{j}  {p}{suffix}'
            .replace("  --note", " --note")
        )
        for partner, agent, reason in run_pairs:
            lines.append(f"    comparable to run {partner} ({agent}): {reason}")
    for current, pair_entry in pairs_by_run.items():
        run_pairs = pair_entry["partners"]
        ids = ",".join(str(partner) for partner, _, _ in run_pairs)
        axes = pair_entry["delivery"]
        if axes != "none":
            axes += " " + pair_entry["quality"]
        if pair_entry["job"] in WRITING_JOBS and axes != "none":
            axes += " " + pair_entry["fidelity"]
        lines.append(f"  orch judge {current} {axes} --better-than {ids} | --worse-than {ids} | --same-as {ids}")
        for partner, agent, reason in run_pairs:
            lines.append(f"    comparable to run {partner} ({agent}): {reason}")
    con.close()
    if notes:
        if lines:
            lines.append("")
        lines.append(f"{len(notes)} notes filed; keep, drop or promote with hub note:")
        for note_id, project, note_text in notes:
            lines.append(f"  {note_id}  {project}  {note_text[:80]}")
    if cleanup_holds:
        if lines:
            lines.append("")
        lines.append(f"{len(cleanup_holds)} worktree{'s' if len(cleanup_holds) > 1 else ''} hold irreplaceable or explicitly retained work:")
        lines.extend(f"  {hold}" for hold in cleanup_holds)
    if rows:
        needs_rescore = any(delivery is not None for _, _, _, _, delivery, _, _, _, _, _, _, _ in rows)
        intro = (
            f"{len(rows)} delegated run{'s' if len(rows) > 1 else ''} from this session "
            f"{'have' if len(rows) > 1 else 'has'} not been scored"
            + ("; rescore those a later turn moved" if needs_rescore else "")
            + ":"
        )
    elif pairs:
        intro = f"{len(pairs)} scored pair{'s' if len(pairs) > 1 else ''} await comparison:"
    elif notes:
        intro = f"{len(notes)} note{'s' if len(notes) > 1 else ''} filed in this session:"
    else:
        intro = f"{len(cleanup_holds)} worktree{'s' if len(cleanup_holds) > 1 else ''} must be resolved before this session ends:"
    guidance = ""
    if rows:
        guidance += (
            "Score each one from what you actually saw in its output. An unscored run "
            "teaches the router nothing; a guessed score teaches it something false. "
            "If a run's output was never used, score it honestly on whether it answered "
            "the question, then continue."
        )
    if pairs:
        guidance += (" " if guidance else "") + (
            "Record each pair once from the outputs you already read."
        )
    print(json.dumps({
        "decision": "block",
        "reason": (
            intro + "\n\n" + "\n".join(lines) + "\n\n" + guidance
        ),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
