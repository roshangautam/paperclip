# Agent Runtime Image Family

Paperclip's server image is the control plane. These images are separate,
non-root execution environments for coding-agent harnesses. A sandbox provider
starts the appropriate runtime image for a lease, mounts the workspace and
runtime command, and removes the sandbox when the run finishes.

The runtime images are not long-running agent services and do not need to be
added to the Paperclip server image.

## Image lineup

- **`agent-runtime-base`**: Ubuntu 22.04, Node 22, git, tini, ripgrep,
  UID/GID 1000, and `paperclip-agent-shim`.
- **`agent-runtime-opencode`**: Adds `opencode-ai`.
- **`agent-runtime-pi`**: Adds `@mariozechner/pi-coding-agent`.
- **`agent-runtime-codex`**: Adds `@openai/codex`.
- **`agent-runtime-gemini`**: Adds `@google/gemini-cli` and its headless
  API-key authentication setting.
- **`agent-runtime-claude`**: Adds `@anthropic-ai/claude-code` and the
  `claude-code` command expected by the shim.
- **`agent-runtime-hermes`**: Reserved placeholder. It does not install a
  Hermes runtime yet.

## Runtime contract

All images inherit these defaults from `agent-runtime-base`:

- `USER 1000:1000` (`paperclip`);
- `WORKDIR /workspace`;
- `ENTRYPOINT ["/usr/bin/tini", "--"]`;
- `CMD ["/usr/local/bin/paperclip-agent-shim"]`;
- writable home, npm cache, XDG cache/config/data/state, and workspace
  directories owned by UID/GID 1000.

Each real harness is installed globally as root during the image build. The
build uses root-only home and cache paths, then leaves the installed package
root-owned and non-writable by the runtime user. Harness state created while an
agent runs therefore lands in `/home/paperclip`, while the shared executable
cannot be modified by that agent.

The shim reads `/run/paperclip/runtime-command.json` (or a path passed with
`-spec`) and replaces itself with the requested CLI using `syscall.Exec`:

```json
{
  "command": "claude-code",
  "args": ["--print", "Inspect the assigned workspace"]
}
```

Provider credentials and deployment policy are supplied per lease; they are
not baked into these images.

## Build locally

All targets build for `linux/amd64`. Derived targets use Buildx named contexts,
so a local build can chain them to the base target without first publishing the
base image:

```bash
REGISTRY=localhost/paperclip VERSION=dev \
  docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
```

Build a smaller subset while iterating:

```bash
REGISTRY=localhost/paperclip VERSION=dev \
  docker buildx bake -f docker/agent-runtime/buildx-bake.hcl \
  base codex claude --load
```

## Verify locally

```bash
node --test docker/agent-runtime/runtime-images.test.mjs
(cd tools/agent-shim && go test ./...)

docker run --rm localhost/paperclip/agent-runtime-base:dev \
  sh -lc 'test "$(id -u):$(id -g)" = 1000:1000 && touch "$HOME/.runtime-write-check"'
docker run --rm localhost/paperclip/agent-runtime-codex:dev codex --version
```

TrueNAS image publication, compose wiring, sandbox-provider selection, and
network policy belong to the deployment configuration that consumes these
images. They are intentionally not encoded in this image family.

## Publishing

The existing `.github/workflows/agent-runtime-images.yml` publishes the base
and five real harness images to `ghcr.io/paperclipai` and signs their digests.
Hermes remains outside the default publishing set until it has a supported
runtime package.
