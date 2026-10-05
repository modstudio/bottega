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
import uuid


def _start(orch, *args, env=None, cwd=None):
    return subprocess.Popen(
        [orch, *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        cwd=cwd,
    )


def _state_root(env=None):
    environment = env if env is not None else os.environ
    override = environment.get("BOTTEGA_STATE_HOME")
    state_slug = "BOTTEGA_STATE_HOME".removesuffix("_STATE_HOME").lower()
    if override:
        if not os.path.isabs(override):
            raise RuntimeError(
                "BOTTEGA_STATE_HOME must be an absolute state root; "
                "set it to an absolute path"
            )
        return override
    xdg = environment.get("XDG_STATE_HOME")
    if xdg and os.path.isabs(xdg):
        return os.path.join(xdg, state_slug)
    home = environment.get("HOME")
    if not home:
        raise RuntimeError("cannot resolve platform state directory")
    return os.path.join(home, ".local", "state", state_slug)


def _start_settings_apply(orch, env=None):
    log_path = os.path.join(_state_root(env), "orchestrator", "settings-apply.log")
    os.makedirs(os.path.dirname(log_path), mode=0o700, exist_ok=True)
    descriptor = os.open(
        log_path,
        os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW,
        0o600,
    )
    log = os.fdopen(descriptor, "a", encoding="utf-8")
    offset = os.lseek(descriptor, 0, os.SEEK_END)
    try:
        proc = subprocess.Popen(
            [orch, "settings", "apply"],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
            start_new_session=True,
        )
    finally:
        log.close()
    return proc, log_path, offset


def _wait_settings_apply(proc, deadline, log_path, offset):
    try:
        timeout = None if proc.poll() is not None else max(0, deadline - time.monotonic())
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    descriptor = os.open(log_path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "r", encoding="utf-8", errors="replace") as log:
        log.seek(offset)
        output = log.read()
    return subprocess.CompletedProcess(proc.args, proc.returncode, output, "")


def _settings_apply_start_failure(error):
    return f"Settings apply was not started: {error}."


def _settings_apply_read_failure(log_path, error):
    return f"Settings apply result at {log_path} could not be read: {error}."


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

# Least important first. Board notices are separately droppable at lowest priority.
_HOOK_CONTEXT_DROPPABLE = (
    ("board", "board notices", "orch board read --all"),
    ("issues", "filed issues", "orch fix-defect --waiting"),
    ("inbox", "inbox detail", "orch inbox"),
    ("extra", "heartbeat and monitor extra", "orch monitor"),
    ("resume_table", "resume table", "orch doc resumes"),
)
_HOOK_CONTEXT_REST = ("resume_table", "inbox", "issues", "extra", "board")


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


def _board_slice(completed):
    if completed is None or completed.returncode != 0:
        return "", []
    try:
        result = json.loads(completed.stdout)
        if isinstance(result, list):
            rows = result
            warning = None
        elif isinstance(result, dict):
            rows = result.get("notices")
            warning = result.get("warning")
            if warning is not None and not isinstance(warning, str):
                raise ValueError("invalid board warning")
        else:
            raise ValueError("invalid board notice response")
        def board_id(row):
            value = row.get("id") if isinstance(row, dict) else None
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                return str(value)
            if isinstance(value, str) and value.isascii() and value.isdigit() and value[0] != "0":
                return value
            if isinstance(value, str) and str(uuid.UUID(value)) == value.lower():
                return value
            raise ValueError("invalid board notice id")

        if not isinstance(rows, list) or not all(
            isinstance(row, dict) and isinstance(row.get("text"), str) for row in rows
        ):
            raise ValueError("invalid board notice response")
        text = "\n\n".join([*(row["text"] for row in rows), *([warning] if warning else [])])
        return text, [board_id(row) for row in rows]
    except Exception:
        return "", []


def _emitted_board_ids(output, board_text, board_ids):
    emitted_context = (
        output.get("hookSpecificOutput", {}).get("additionalContext", "")
        if isinstance(output, dict) else ""
    )
    return list(board_ids) if board_ids and board_text and board_text in emitted_context else []


def _valid_notice_id(value):
    source, separator, identifier = value.partition(":") if isinstance(value, str) else ("", "", "")
    if source not in ("condition", "landing", "board") or separator != ":":
        return False
    if identifier.isdigit():
        return int(identifier) > 0
    try:
        return source == "board" and str(uuid.UUID(identifier)) == identifier.lower()
    except ValueError:
        return False


def _monitor_delivery(stdout, owner_session):
    result = json.loads(stdout)
    if isinstance(result, list):
        rows = result
        warning = None
    elif isinstance(result, dict):
        rows = result.get("notices")
        warning = result.get("warning")
    else:
        raise ValueError("invalid monitor notice JSON")
    if not isinstance(rows, list) or (warning is not None and not isinstance(warning, str)):
        raise ValueError("invalid monitor notice JSON")
    if not all(
        isinstance(item, dict)
        and isinstance(item.get("kind"), str)
        and isinstance(item.get("subject"), str)
        and isinstance(item.get("detail"), str)
        and isinstance(item.get("noticeId"), str)
        and _valid_notice_id(item["noticeId"])
        and item.get("ownerSession") == owner_session
        for item in rows
    ):
        raise ValueError("invalid monitor notice JSON")
    return rows, warning


def _monitor_notice_command(orch, skip_board_refresh=False):
    command = [orch, "monitor", "--notices", "--json"]
    if skip_board_refresh:
        command.append("--skip-board-refresh")
    return command


def assemble_additional_context(
    autonomy="",
    resume_offer="",
    resume_table="",
    inbox="",
    issues="",
    extra="",
    board="",
    budget=HOOK_CONTEXT_MAX_CHARS,
):
    sections = {
        "autonomy": autonomy.strip(),
        "resume_offer": resume_offer.strip(),
        "resume_table": resume_table.strip(),
        "inbox": inbox.strip(),
        "issues": issues.strip(),
        "extra": extra.strip(),
        "board": board.strip(),
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


def _settings_apply_notice(completed, log_path=None):
    if completed is None:
        return f"settings apply still running; its result lands in {log_path}"
    lines = [
        line.strip()
        for text in (completed.stdout or "", completed.stderr or "")
        for line in text.splitlines()
        if line.strip()
    ]
    if completed.returncode != 0:
        refused = [line for line in lines if "refused" in line]
        detail = "; ".join(refused or lines[:1])
        suffix = f": {detail}" if detail else ""
        return f"Settings apply failed with exit {completed.returncode}{suffix}."
    if any(": applied;" in line for line in lines):
        return "settings applied; they take effect in the next session"
    return None


def orch_worker_session(env=None):
    return bool((env if env is not None else os.environ).get("ORCH_RUN_ID"))


def main() -> int:
    if orch_worker_session():
        return 0
    resumes_p = inbox_p = waiting_p = monitor_p = context_p = settings_p = board_p = None
    settings_log_path = settings_log_offset = None
    settings_start_failure = None
    settings_read_failure = None
    capability_dir = None
    output = None
    board_text = ""
    board_ids = []
    cwd = None
    orch = None
    monitor_notices = []
    monitor_warning = None
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
            subprocess.run(
                [orch, "board", "presence"], env=inbox_env, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, timeout=1, check=False, cwd=cwd
            )
            board_p = _start(orch, "board", "read", "--claim", env=inbox_env, cwd=cwd)
        inbox_p = _start(
            orch, "inbox", "--all", "--active", "--cwd", cwd, "--json", env=inbox_env
        )
        waiting_p = _start(orch, "fix-defect", "--waiting", "--cwd", cwd, "--json")
        context_p = _start(orch, "context", "--cwd", cwd, "--json")
        try:
            settings_p, settings_log_path, settings_log_offset = _start_settings_apply(orch)
        except Exception as error:
            settings_start_failure = _settings_apply_start_failure(error)
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
                monitor_p = _start(
                    *_monitor_notice_command(orch, skip_board_refresh=True), env=inbox_env
                )
                notice_deadline = time.monotonic() + notice_timeout
            except Exception:
                monitor_failure = "Monitor notice delivery failed; addressed condition state is unknown."
        deadline = time.monotonic() + 10
        resumes = _wait(resumes_p, deadline)
        inbox = _wait(inbox_p, deadline)
        waiting = _wait(waiting_p, deadline)
        autonomy = _wait(context_p, deadline)
        board = _wait(board_p, deadline) if board_p is not None else None
        board_text, board_ids = _board_slice(board)
        settings_apply = None
        if settings_p is not None:
            try:
                settings_apply = _wait_settings_apply(
                    settings_p, deadline, settings_log_path, settings_log_offset
                )
            except Exception as error:
                settings_read_failure = _settings_apply_read_failure(
                    settings_log_path, error
                )

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
        settings_notice = (
            settings_start_failure
            or settings_read_failure
            or _settings_apply_notice(settings_apply, settings_log_path)
        )
        if settings_notice:
            notices.append(settings_notice)
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
            "board": board_text,
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
                    monitor_notices, monitor_warning = _monitor_delivery(monitor.stdout, sid)
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
        if monitor_notices or monitor_warning:
            monitor_text = "\n".join([
                *(
                    f'MONITOR {item["kind"]} {item["subject"]}: {item["detail"]}'
                    for item in monitor_notices
                ),
                *([monitor_warning] if monitor_warning else []),
            ])
            context = assemble_additional_context(
                **{**health_sections, "extra": _join_sections(extra_section, monitor_text)}
            )
            if monitor_notices:
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
        emitted_board_ids = _emitted_board_ids(output, board_text, board_ids)
        if emitted_board_ids and inbox_env is not None and orch is not None:
            try:
                subprocess.run(
                    [orch, "board", "delivered", ",".join(str(item) for item in emitted_board_ids)],
                    env=inbox_env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=acknowledgement_timeout,
                    check=False,
                    cwd=cwd,
                )
            except Exception:
                pass
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
        _kill(board_p)
        if capability_dir:
            shutil.rmtree(capability_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
