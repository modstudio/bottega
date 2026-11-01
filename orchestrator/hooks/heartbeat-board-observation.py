#!/usr/bin/env python3
"""Project board rows into the plain roots/replies heartbeat policy input."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys


def _safe_title(value: object, redact_secret_shaped) -> str:
    title = str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")
    return redact_secret_shaped(title)[0]


def observe_board_requests(path: str, session_id: str, redact_secret_shaped) -> dict:
    """Return plain authored-root and reply rows from local and hosted caches."""
    if not os.path.exists(path):
        return {"roots": [], "replies": [], "holds": []}
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
    try:
        local_receipts = {
            row[0]: row[1]
            for row in connection.execute(
                "SELECT message_record_id,delivered_at FROM board_receipt WHERE reader_session=?",
                (session_id,),
            )
        }
        roots, replies = [], []
        for row in connection.execute(
            "SELECT record_id,number,kind,purpose,author_session,title,expires_at,withdrawn_at,"
            "thread_root_record_id,created_at "
            "FROM board_message"
        ):
            record_id, number, kind, purpose, author, title, expires, withdrawn, root_id, created = row
            if root_id is None:
                roots.append(
                    {
                        "id": record_id,
                        "label": f"board:{number} {_safe_title(title, redact_secret_shaped)}",
                        "kind": kind,
                        "purpose": purpose,
                        "author_session": author,
                        "title": _safe_title(title, redact_secret_shaped),
                        "expires_at": expires,
                        "withdrawn_at": withdrawn,
                        "created_at": created,
                    }
                )
            else:
                replies.append(
                    {
                        "root_id": root_id,
                        "author_session": author,
                        "delivered_at": local_receipts.get(record_id),
                        "created_at": created,
                    }
                )
        hosted_receipts = {
            row[0]: row[1]
            for row in connection.execute(
                "SELECT message_id,delivered_at FROM hosted_board_receipt_cache WHERE reader_session=?",
                (session_id,),
            )
        }
        for message_id, kind, root_id, payload in connection.execute(
            "SELECT id,kind,thread_root_id,payload FROM hosted_board_message_cache"
        ):
            message = json.loads(payload)
            author = message.get("authorSession")
            if author is None and isinstance(message.get("origin"), dict):
                author = message["origin"].get("session")
            if root_id is None:
                roots.append(
                    {
                        "id": message_id,
                        "label": f"board:{message_id} {_safe_title(message.get('title'), redact_secret_shaped)}",
                        "kind": kind,
                        "purpose": message.get("purpose"),
                        "author_session": author,
                        "title": _safe_title(message.get('title'), redact_secret_shaped),
                        "expires_at": message.get("expiresAt"),
                        "withdrawn_at": message.get("withdrawnAt"),
                        "created_at": message.get("createdAt"),
                    }
                )
            else:
                replies.append(
                    {
                        "root_id": root_id,
                        "author_session": author,
                        "delivered_at": hosted_receipts.get(message_id),
                        "created_at": message.get("createdAt"),
                    }
                )
        has_hold_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_board_hold'"
        ).fetchone()
        holds = (
            [
                {
                    "message_id": row[0],
                    "session_id": session_id,
                    "created_at": row[1],
                    "title": next(
                        (root["title"] for root in roots if root["id"] == row[0]), ""
                    ),
                }
                for row in connection.execute(
                    "SELECT message_record_id,created_at FROM session_board_hold "
                    "WHERE session_id=? AND released_at IS NULL ORDER BY created_at,record_id",
                    (session_id,),
                )
            ]
            if has_hold_table
            else []
        )
        return {"roots": roots, "replies": replies, "holds": holds}
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("database")
    parser.add_argument("session_id")
    args = parser.parse_args()
    import heartbeat_decision

    print(
        json.dumps(
            observe_board_requests(
                args.database, args.session_id, heartbeat_decision.redact_secret_shaped
            )
        )
    )
    return 0


if __name__ == "__main__":
    # The install asset keeps its hyphenated name; expose an importable alias to
    # the adjacent decision module without duplicating its policy here.
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "heartbeat_decision", os.path.join(os.path.dirname(__file__), "heartbeat-decision.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules["heartbeat_decision"] = module
    raise SystemExit(main())
