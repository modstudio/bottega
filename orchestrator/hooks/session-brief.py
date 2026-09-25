#!/usr/bin/env python3
"""SessionStart hook: resume briefs and monitor findings addressed here."""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time


def _start(orch, *args, env=None):
    return subprocess.Popen(
        [orch, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )


def _kill(proc):
    if proc is None or proc.poll() is not None:
        return
    proc.kill()
    try:
        proc.communicate()
    except Exception:
        pass


def _wait(proc, deadline):
    try:
        timeout = None if proc.poll() is not None else max(0, deadline - time.monotonic())
        stdout, _ = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout or "", _ or "")
    except Exception:
        _kill(proc)
        return subprocess.CompletedProcess(proc.args, -1, "", None)


def _resume_sentence(source, open_briefs):
    continuation = source in ("clear", "compact", "fork")
    if len(open_briefs) == 1:
        slug = open_briefs[0]["slug"]
        if continuation:
            return (
                f"Open resume brief `{slug}`. Offer to resume from it; "
                "fetch with get_doc only after they agree, then run orch doc consume."
            )
        return (
            f"Open resume brief `{slug}`. Ask whether to load it before fetching with get_doc; "
            "after they agree and it is loaded, run orch doc consume."
        )
    if continuation:
        return (
            "Open resume briefs above. Offer to resume from one of them; "
            "fetch with get_doc only after they agree, then run orch doc consume."
        )
    return (
        "Open resume briefs above. Ask which (if any) to load before fetching with get_doc; "
        "after they agree and one is loaded, run orch doc consume."
    )


HOOK_CONTEXT_MAX_CHARS = 9000
HOOK_CONTEXT_TRUNCATION_MARKER = "…"

# Least important first. Display order of the rest is resume table, inbox, issues, extra.
_HOOK_CONTEXT_DROPPABLE = (
    ("issues", "filed issues", "orch fix-defect --waiting"),
    ("inbox", "inbox detail", "orch inbox"),
    ("extra", "heartbeat and monitor extra", "orch monitor"),
    ("resume_table", "resume table", "orch doc resumes"),
)
_HOOK_CONTEXT_REST = ("resume_table", "inbox", "issues", "extra")


def _join_sections(*sections):
    return "\n".join(section for section in sections if section)


def _drop_note(dropped):
    if not dropped:
        return ""
    parts = [f"{name} ({command})" for name, command in dropped]
    if len(parts) == 1:
        return f"Dropped {parts[0]}."
    return f"Dropped {', '.join(parts[:-1])} and {parts[-1]}."


def _fit_to_budget(text, budget):
    if len(text) <= budget:
        return text
    marker = HOOK_CONTEXT_TRUNCATION_MARKER
    if budget < len(marker):
        return ""
    return text[: budget - len(marker)] + marker


def assemble_additional_context(
    autonomy="",
    resume_offer="",
    resume_table="",
    inbox="",
    issues="",
    extra="",
    budget=HOOK_CONTEXT_MAX_CHARS,
):
    sections = {
        "autonomy": autonomy.strip(),
        "resume_offer": resume_offer.strip(),
        "resume_table": resume_table.strip(),
        "inbox": inbox.strip(),
        "issues": issues.strip(),
        "extra": extra.strip(),
    }
    included = {key: sections[key] for key, _, _ in _HOOK_CONTEXT_DROPPABLE}
    dropped = []

    def compose():
        rest = [included[key] for key in _HOOK_CONTEXT_REST]
        body = _join_sections(sections["autonomy"], sections["resume_offer"], *rest)
        return _join_sections(body, _drop_note(dropped))

    text = compose()
    if len(text) <= budget:
        return text
    for key, name, command in _HOOK_CONTEXT_DROPPABLE:
        if not included[key]:
            continue
        included[key] = ""
        dropped.append((name, command))
        text = compose()
        if len(text) <= budget:
            return text
    return _fit_to_budget(text, budget)


def _autonomy_slice(completed):
    if completed.returncode == -1:
        return "", "Autonomy observation timed out; autonomy state is unknown."
    if completed.returncode != 0:
        return (
            "",
            f"Autonomy command failed with exit {completed.returncode}; autonomy state is unknown.",
        )
    try:
        result = json.loads(completed.stdout)
        if not isinstance(result, dict) or not isinstance(result.get("registered"), bool):
            raise ValueError("invalid context JSON")
        if not result["registered"]:
            return "", None
        text = result.get("text")
        if not isinstance(text, str):
            raise ValueError("invalid context JSON")
        return text, None
    except Exception:
        return "", "Autonomy response was invalid; autonomy state is unknown."


def main() -> int:
    resumes_p = inbox_p = waiting_p = monitor_p = context_p = None
    capability_dir = None
    output = None
    monitor_notices = []
    inbox_env = None
    notice_timeout = 1.0
    acknowledgement_timeout = 1.0
    notice_deadline = None
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd")
        if not cwd:
            return 0
        sid = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        orch = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch"))
        if not os.access(orch, os.X_OK):
            message = f"Inbox command is missing or not executable: {orch}; question state is unknown."
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": "",
                },
                "systemMessage": message,
            }
            return 0
        resumes_p = _start(orch, "doc", "resumes", "--cwd", cwd, "--json")
        inbox_env = os.environ.copy()
        if sid:
            inbox_env["CLAUDE_CODE_SESSION_ID"] = sid
        inbox_p = _start(
            orch, "inbox", "--all", "--active", "--cwd", cwd, "--json", env=inbox_env
        )
        waiting_p = _start(orch, "fix-defect", "--waiting", "--cwd", cwd, "--json")
        context_p = _start(orch, "context", "--cwd", cwd, "--json")
        monitor_failure = None
        if sid:
            try:
                capability_dir = tempfile.mkdtemp(prefix="orch-monitor-hook-")
                capability_path = os.path.join(capability_dir, "capability.json")
                capability_token = secrets.token_hex(32)
                with open(capability_path, "x", encoding="utf-8") as capability_file:
                    os.chmod(capability_path, 0o600)
                    json.dump({"token": capability_token, "pid": os.getpid()}, capability_file)
                inbox_env["ORCH_MONITOR_CAPABILITY_PATH"] = capability_path
                inbox_env["ORCH_MONITOR_CAPABILITY_TOKEN"] = capability_token
                monitor_p = _start(orch, "monitor", "--notices", "--json", env=inbox_env)
                notice_deadline = time.monotonic() + notice_timeout
            except Exception:
                monitor_failure = "Monitor notice delivery failed; addressed condition state is unknown."
        deadline = time.monotonic() + 10
        resumes = _wait(resumes_p, deadline)
        inbox = _wait(inbox_p, deadline)
        waiting = _wait(waiting_p, deadline)
        autonomy = _wait(context_p, deadline)

        resume_table = ""
        resume_offer = ""
        extra_section = ""
        open_briefs = []
        lines = []
        unreadable = []
        resume_failure = None
        if resumes.returncode == 0:
            try:
                result = json.loads(resumes.stdout)
                if not isinstance(result, dict):
                    raise ValueError("invalid resume list JSON")
                raw_open = result.get("open")
                raw_unreadable = result.get("unreadable")
                if not isinstance(raw_open, list):
                    resume_failure = "Resume response was invalid; brief state is unknown."
                    raw_open = []
                for item in raw_open:
                    slug = item.get("slug") if isinstance(item, dict) else None
                    if (
                        isinstance(item, dict)
                        and isinstance(slug, str)
                        # Source of truth: docs.ts validateHistoricAddress. Slugs are 1-64
                        # lowercase letters, digits, or hyphens, starting alphanumeric.
                        and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", slug)
                        and isinstance(item.get("title"), str)
                        and isinstance(item.get("age"), str)
                    ):
                        open_briefs.append(item)
                    else:
                        resume_failure = "Resume response was invalid; brief state is unknown."
                if not isinstance(raw_unreadable, list):
                    resume_failure = "Resume response was invalid; brief state is unknown."
                    raw_unreadable = []
                for item in raw_unreadable:
                    if (
                        isinstance(item, dict)
                        and isinstance(item.get("slug"), str)
                        and item.get("reason") in ("no-frontmatter", "no-readable-status", "unrecognized-status")
                    ):
                        unreadable.append(item)
                    else:
                        resume_failure = "Resume response was invalid; brief state is unknown."
                lines = [
                    f'{item["slug"]:<24} {item["title"]:<24} {item["age"]}'
                    for item in open_briefs
                ]
            except Exception:
                resume_failure = "Resume response was invalid; brief state is unknown."
            if lines:
                resume_table = "\n".join(lines)
                resume_offer = _resume_sentence(payload.get("source"), open_briefs)
            if unreadable:
                unread = "\n".join(
                    f'UNREADABLE RESUME BRIEF `{item["slug"]}`: {item["reason"]}.'
                    for item in unreadable
                )
                resume_table = _join_sections(resume_table, unread)
        elif resumes.returncode == -1:
            resume_failure = "Resume observation timed out; brief state is unknown."
        else:
            first = next(
                (line.strip() for line in (resumes.stderr or "").splitlines() if line.strip()),
                None,
            )
            detail = f": {first}" if first else ""
            resume_failure = (
                f"Resume command failed with exit {resumes.returncode}{detail}; "
                "brief state is unknown."
            )

        answerable_count = foreign_count = unknown_count = 0
        inbox_failure = None
        if inbox.returncode == 0:
            try:
                inbox_result = json.loads(inbox.stdout)
                if (
                    not isinstance(inbox_result, dict)
                    or not isinstance(inbox_result.get("cwd_registered"), bool)
                    or (
                        inbox_result.get("project") is not None
                        and not isinstance(inbox_result.get("project"), str)
                    )
                ):
                    raise ValueError("invalid scoped inbox JSON")
                questions = inbox_result.get("rows")
                if not isinstance(questions, list) or not all(
                    isinstance(item, dict)
                    and item.get("session_liveness") in ("live", "unknown")
                    and isinstance(item.get("answer_id"), int)
                    and isinstance(item.get("can_answer"), bool)
                    for item in questions
                ):
                    raise ValueError("invalid inbox JSON")
                answerable_count = sum(item["can_answer"] for item in questions)
                foreign_count = len(
                    {item["answer_id"] for item in questions if not item["can_answer"]}
                )
                unknown_count = len(
                    {
                        item["answer_id"]
                        for item in questions
                        if not item["can_answer"] and item["session_liveness"] == "unknown"
                    }
                )
            except Exception:
                inbox_failure = "Inbox response was invalid; question state is unknown."
        elif inbox.returncode == -1:
            inbox_failure = "Inbox observation timed out; question state is unknown."
        else:
            inbox_failure = (
                f"Inbox command failed with exit {inbox.returncode}; question state is unknown."
            )

        waiting_issues = []
        unworked_issues = []
        unscored_loop_runs = []
        blocked_issue_loop = None
        waiting_failure = None
        if waiting.returncode == 0:
            try:
                waiting_result = json.loads(waiting.stdout)
                if (
                    not isinstance(waiting_result, dict)
                    or not isinstance(waiting_result.get("cwd_registered"), bool)
                    or (
                        waiting_result.get("project") is not None
                        and not isinstance(waiting_result.get("project"), str)
                    )
                ):
                    raise ValueError("invalid scoped filed issue waiting JSON")
                issue_state = waiting_result.get("state")
                if not isinstance(issue_state, dict):
                    raise ValueError("invalid filed issue waiting JSON")
                waiting_issues = issue_state.get("waiting")
                unworked_issues = issue_state.get("unworked")
                unscored_loop_runs = issue_state.get("unscored")
                blocked_issue_loop = issue_state.get("blocked")
                for issues in (waiting_issues, unworked_issues):
                    if not isinstance(issues, list) or not all(
                        isinstance(item, dict)
                        and isinstance(item.get("key"), str)
                        and (item.get("title") is None or isinstance(item.get("title"), str))
                        for item in issues
                    ):
                        raise ValueError("invalid filed issue waiting JSON")
                if not isinstance(unscored_loop_runs, list) or not all(
                    isinstance(item, dict)
                    and isinstance(item.get("runId"), int)
                    and isinstance(item.get("job"), str)
                    and isinstance(item.get("issueKey"), str)
                    for item in unscored_loop_runs
                ):
                    raise ValueError("invalid filed issue unscored JSON")
                if blocked_issue_loop is not None and (
                    not isinstance(blocked_issue_loop, dict)
                    or not isinstance(blocked_issue_loop.get("limit"), int)
                    or not isinstance(blocked_issue_loop.get("held"), list)
                    or not all(
                        isinstance(item, dict)
                        and isinstance(item.get("runId"), int)
                        and isinstance(item.get("path"), str)
                        and isinstance(item.get("why"), str)
                        for item in blocked_issue_loop["held"]
                    )
                ):
                    raise ValueError("invalid filed issue blocked JSON")
            except Exception:
                waiting_issues = []
                unworked_issues = []
                unscored_loop_runs = []
                blocked_issue_loop = None
                waiting_failure = "Filed issue waiting response was invalid; waiting state is unknown."
        elif waiting.returncode == -1:
            waiting_failure = "Filed issue waiting observation timed out; waiting state is unknown."
        else:
            waiting_failure = (
                f"Filed issue waiting command failed with exit {waiting.returncode}; "
                "waiting state is unknown."
            )

        autonomy_section, autonomy_failure = _autonomy_slice(autonomy)
        notices = []
        inbox_lines = []
        issues_lines = []
        if inbox_failure:
            notices.append(inbox_failure)
        if resume_failure:
            notices.append(resume_failure)
        if waiting_failure:
            notices.append(waiting_failure)
        if autonomy_failure:
            notices.append(autonomy_failure)
        if answerable_count:
            noun = "question" if answerable_count == 1 else "questions"
            message = f"{answerable_count} {noun} waiting on your ruling."
            notices.append(message)
            inbox_lines.append(message)
        if foreign_count:
            if foreign_count == 1:
                message = (
                    "1 worker dispatched by another session is waiting on an answer. "
                    "Only the session that dispatched it can answer it."
                )
            else:
                message = (
                    f"{foreign_count} workers dispatched by other sessions are waiting on an "
                    "answer. Only the session that dispatched each one can answer it."
                )
            notices.append(message)
            inbox_lines.append(message)
        if unknown_count:
            if unknown_count == 1:
                message = (
                    "1 of those is from a session not seen recently. It may be closed, and that "
                    "worker may never get an answer."
                )
            else:
                message = (
                    f"{unknown_count} of those are from a session not seen recently. They may be "
                    "closed, and those workers may never get an answer."
                )
            notices.append(message)
            inbox_lines.append(message)
        if waiting_issues:
            keys = ", ".join(item["key"] for item in waiting_issues)
            message = f"{len(waiting_issues)} filed issue(s) waiting on a person: {keys}"
            notices.append(message)
            issues_lines.append(message)
        if unworked_issues:
            keys = ", ".join(item["key"] for item in unworked_issues)
            message = (
                f"{len(unworked_issues)} filed issue(s) not yet worked: {keys} - run orch fix-defect"
            )
            notices.append(message)
            issues_lines.append(message)
        if unscored_loop_runs:
            ids = ", ".join(str(item["runId"]) for item in unscored_loop_runs)
            message = (
                f"{len(unscored_loop_runs)} filed-issue loop run(s) await scoring: {ids} - read with orch result <id>, score with orch judge <id>"
            )
            notices.append(message)
            issues_lines.append(message)
        if blocked_issue_loop:
            held = blocked_issue_loop["held"]
            paths = ", ".join(item["path"] for item in held)
            message = (
                f"Filed-issue loop blocked: {len(held)} held issue trees ({paths}) - clear them before it takes more work"
            )
            notices.append(message)
            issues_lines.append(message)
        if open_briefs:
            slugs = ", ".join(f"`{item['slug']}`" for item in open_briefs)
            noun = "brief" if len(open_briefs) == 1 else "briefs"
            notices.append(f"Open resume {noun}: {slugs}.")
        if unreadable:
            slugs = ", ".join(f"`{item['slug']}`" for item in unreadable)
            noun = "brief" if len(unreadable) == 1 else "briefs"
            notices.append(f"Unreadable resume {noun}: {slugs}.")

        # Verify the heartbeat and hand over a ready-to-run Monitor command.
        # Do not launch it here: a hook cannot call Monitor, and backgrounding
        # it would send output nowhere while the session looked covered.
        # Compact/clear/fork already had their chance; re-handing is wallpaper.
        if payload.get("source") in ("startup", "resume"):
            heartbeat = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "orch-heartbeat.sh")
            )
            if not os.access(heartbeat, os.X_OK):
                msg = f"Heartbeat missing or not executable: {heartbeat}"
                extra_section = _join_sections(extra_section, msg)
                notices.append(msg)
            else:
                # The payload's own session_id first, then the env var Claude always sets.
                if sid:
                    extra_section = _join_sections(
                        extra_section,
                        f"Arm under Monitor from the main checkout: {heartbeat} {sid}",
                    )

        # Health is complete and retained before notice work begins. Notice delivery is
        # supplemental: no failure in minting, fetching, parsing, or acknowledging may
        # cost the SessionStart object that carries brief and question state.
        health_sections = {
            "autonomy": autonomy_section,
            "resume_offer": resume_offer,
            "resume_table": resume_table,
            "inbox": "\n".join(inbox_lines),
            "issues": "\n".join(issues_lines),
            "extra": extra_section,
        }
        health_context = assemble_additional_context(**health_sections)
        health_notices = list(notices)
        if health_context or health_notices:
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": health_context,
                }
            }
            if health_notices:
                output["systemMessage"] = " ".join(health_notices)
        if monitor_p is not None:
            try:
                monitor = _wait(monitor_p, notice_deadline)
                if monitor.returncode == 0:
                    monitor_notices = json.loads(monitor.stdout)
                    if not isinstance(monitor_notices, list) or not all(
                        isinstance(item, dict)
                        and isinstance(item.get("kind"), str)
                        and isinstance(item.get("subject"), str)
                        and isinstance(item.get("detail"), str)
                        and isinstance(item.get("noticeId"), str)
                        and item["noticeId"].partition(":")[0] in ("condition", "landing")
                        and item["noticeId"].partition(":")[1] == ":"
                        and item["noticeId"].partition(":")[2].isdigit()
                        and int(item["noticeId"].partition(":")[2]) > 0
                        and item.get("ownerSession") == sid
                        for item in monitor_notices
                    ):
                        raise ValueError("invalid monitor notice JSON")
                elif monitor.returncode == -1:
                    monitor_failure = "Monitor notice observation timed out; addressed condition state is unknown."
                else:
                    first = next(
                        (line.strip() for line in (monitor.stderr or "").splitlines() if line.strip()),
                        None,
                    )
                    detail = f": {first}" if first else ""
                    monitor_failure = (
                        f"Monitor notice command failed with exit {monitor.returncode}{detail}; "
                        "addressed condition state is unknown."
                    )
            except Exception:
                monitor_notices = []
                monitor_failure = "Monitor notice delivery failed; addressed condition state is unknown."

        context = health_context
        notices = health_notices
        if monitor_failure:
            notices.append(monitor_failure)
        if monitor_notices:
            monitor_text = "\n".join(
                f'MONITOR {item["kind"]} {item["subject"]}: {item["detail"]}'
                for item in monitor_notices
            )
            context = assemble_additional_context(
                **{**health_sections, "extra": _join_sections(extra_section, monitor_text)}
            )
            noun = "condition" if len(monitor_notices) == 1 else "conditions"
            notices.append(f"Monitor addressed {len(monitor_notices)} {noun} to this session.")

        if context or notices:
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": context,
                }
            }
            if notices:
                output["systemMessage"] = " ".join(notices)
    except Exception:
        pass
    finally:
        # Emission is deliberately outside the catch-all above. Once health has been
        # assembled, no exception in supplemental notice work can swallow it.
        if output is not None:
            sys.stdout.write(json.dumps(output) + "\n")
            sys.stdout.flush()
        if monitor_notices and inbox_env is not None:
            try:
                subprocess.run(
                    [orch, "monitor", "--ack-notices", ",".join(
                        str(item["noticeId"]) for item in monitor_notices
                    )],
                    env=inbox_env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=acknowledgement_timeout,
                    check=False,
                )
            except Exception:
                pass
        _kill(resumes_p)
        _kill(inbox_p)
        _kill(waiting_p)
        _kill(context_p)
        _kill(monitor_p)
        if capability_dir:
            shutil.rmtree(capability_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
