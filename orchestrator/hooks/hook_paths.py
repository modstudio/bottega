"""Paths shared by harness hooks."""

import os


def bottega_bin():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    return os.path.join(root, "bin", "bottega")
