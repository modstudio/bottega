#!/usr/bin/env python3
"""Project board rows into the plain roots/replies heartbeat policy input."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys


def _safe_title(value: object, contains_secret_shaped) -> str:
    title = str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")
    return "title withheld (secret-shaped)" if contains_secret_shaped(title) else title


def observe_board_requests(path: str, session_id: str, contains_secret_shaped) -> dict:
    """Return plain authored-root and reply rows from local and hosted caches."""
    if not os.path.exists(path):
        return {"roots": [], "replies": []}
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
            "SELECT record_id,number,kind,purpose,author_session,title,expires_at,withdrawn_at,thread_root_record_id "
            "FROM board_message"
        ):
            record_id, number, kind, purpose, author, title, expires, withdrawn, root_id = row
            if root_id is None:
                roots.append(
                    {
                        "id": record_id,
                        "label": f"board:{number} {_safe_title(title, contains_secret_shaped)}",
                        "kind": kind,
                        "purpose": purpose,
                        "author_session": author,
                        "expires_at": expires,
                        "withdrawn_at": withdrawn,
                    }
                )
            else:
                replies.append(
                    {
                        "root_id": root_id,
                        "author_session": author,
                        "delivered_at": local_receipts.get(record_id),
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
                        "label": f"board:{message_id} {_safe_title(message.get('title'), contains_secret_shaped)}",
                        "kind": kind,
                        "purpose": message.get("purpose"),
                        "author_session": author,
                        "expires_at": message.get("expiresAt"),
                        "withdrawn_at": message.get("withdrawnAt"),
                    }
                )
            else:
                replies.append(
                    {
                        "root_id": root_id,
                        "author_session": author,
                        "delivered_at": hosted_receipts.get(message_id),
                    }
                )
        return {"roots": roots, "replies": replies}
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
                args.database, args.session_id, heartbeat_decision.contains_secret_shaped
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
