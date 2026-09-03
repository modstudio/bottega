# local-stack

Local model serving on a host reached through an SSH tunnel.

The orchestrator consumes an OpenAI-compatible Responses endpoint exposed on a
local port; it does not import from this concern. The contract between them is
the endpoint selected by `ORCH_LOCAL_BASE_URL`, and nothing more.

A host is declared by an SSH config alias, the local and remote forwarding
ports, and `ops/launchd/com.user.local-model-tunnel.plist.template`.
`LOCAL_MODEL_HOST` supplies the alias when `ops/install.sh` renders the
template. Keep the server bound to localhost on the model host, because the
tunnel is the security boundary, and verify that it serves `/v1/responses`.

Facts about a particular host belong in machine-scope docs, not this tree:

```
orch doc list --scope machine
```

Product-specific deployment stays beside the agent definition that depends on
it. If a second consumer appears, move that deployment here.
