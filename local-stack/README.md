# local-stack

Local model serving, and the contract the orchestrator consumes.

The orchestrator does not import from here. The contract is an OpenAI-compatible
Responses endpoint exposed on a local port and selected with
`ORCH_LOCAL_BASE_URL`.

## Declaring a host

Define an SSH config alias for the model host, choose the remote model-server
port and an unused local forwarding port, and install the launchd tunnel from
`ops/launchd/com.user.local-model-tunnel.plist.template`.

Set `LOCAL_MODEL_HOST` to the SSH alias when running `ops/install.sh`. The
template uses that alias and the current home directory; edit its `-L` argument
if the chosen ports differ from the template. Set `ORCH_LOCAL_BASE_URL` to the
forwarded local `/v1` URL and set `ORCH_LOCAL_MODEL` to the served model name.
These variables must be visible to non-interactive shells that run `orch`.

The inference server binds localhost on the model host. The SSH tunnel is the
only route to it, because inference servers commonly have no authentication and
must not be exposed on a routable interface.

The serving layer must implement the OpenAI Responses API, not only Chat
Completions. Codex depends on `/v1/responses`; verify that endpoint before
declaring the host usable.

Any product-specific provisioning belongs with the agent definition that
depends on it. The host's identity, network, hardware, measurements, credentials
and incident history are machine-scoped operator docs, available with:

```
orch doc list --scope machine
```
