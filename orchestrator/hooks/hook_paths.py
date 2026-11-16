"""Paths shared by harness hooks."""

import os


def bottega_bin():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    return os.path.join(root, "bin", "bottega")


def state_root(env=None):
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
