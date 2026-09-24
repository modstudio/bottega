#!/usr/bin/env python3
import importlib.util
import json
import sys

hook_path, fixture_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("no_attribution", hook_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
markers = module.load_markers()
if markers is None:
    raise RuntimeError("hook marker list did not compile")
with open(fixture_path, encoding="utf-8") as fixture_file:
    fixture = json.load(fixture_file)
for text in fixture["blocked"]:
    if not markers.search(text):
        raise AssertionError(f"blocked fixture passed: {text!r}")
for text in fixture["allowed"]:
    if markers.search(text):
        raise AssertionError(f"allowed fixture was blocked: {text!r}")
