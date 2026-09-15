---
description: Rules for the local model service and its tunnel boundary
paths: ["local-stack/**"]
---

# Local model service

The orchestrator consumes the OpenAI-compatible Responses endpoint selected by
`ORCH_LOCAL_BASE_URL`; local-stack and orchestrator do not import one another.

The model server stays bound to localhost on its host, because the SSH tunnel is the
security boundary. A service change must verify `/v1/responses` through that tunnel.

`LOCAL_MODEL_HOST` names the SSH config alias rendered by `ops/install.sh`. Facts about a
particular host belong in the machine docs `local-model-host-hardware`,
`local-model-host-network`, and `local-model-host-tunnel` rather than in this tree.

Product-specific deployment stays beside the agent definition that depends on it. Move a
deployment here when it has more than one consumer.
