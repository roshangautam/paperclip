import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimeDir = new URL("./", import.meta.url);
const realHarnesses = [
  ["claude", "@anthropic-ai/claude-code", "claude-code"],
  ["codex", "@openai/codex", "codex"],
  ["gemini", "@google/gemini-cli", "gemini"],
  ["opencode", "opencode-ai", "opencode"],
  ["pi", "@mariozechner/pi-coding-agent", "pi"],
];

function read(name) {
  return readFileSync(new URL(name, runtimeDir), "utf8");
}

test("the base image defines a writable non-root runtime contract", () => {
  const base = read("Dockerfile.base");

  assert.match(base, /groupadd -g 1000 paperclip/);
  assert.match(base, /useradd -u 1000 -g 1000 -d \/home\/paperclip/);
  assert.match(base, /install -d -o 1000 -g 1000[\s\S]*\/workspace/);
  assert.match(base, /^ENV HOME=\/home\/paperclip \\/m);
  assert.match(base, /NPM_CONFIG_CACHE=\/home\/paperclip\/\.cache\/npm/);
  assert.match(base, /XDG_CACHE_HOME=\/home\/paperclip\/\.cache/);
  assert.match(base, /XDG_CONFIG_HOME=\/home\/paperclip\/\.config/);
  assert.match(base, /XDG_DATA_HOME=\/home\/paperclip\/\.local\/share/);
  assert.match(base, /XDG_STATE_HOME=\/home\/paperclip\/\.local\/state/);
  assert.match(base, /^USER 1000:1000$/m);
  assert.match(base, /^WORKDIR \/workspace$/m);
  assert.match(base, /^ENTRYPOINT \["\/usr\/bin\/tini", "--"]$/m);
  assert.match(base, /^CMD \["\/usr\/local\/bin\/paperclip-agent-shim"]$/m);
});

test("every real harness installs outside the runtime user's home", () => {
  for (const [name, packageName, command] of realHarnesses) {
    const dockerfile = read(`Dockerfile.${name}`);

    assert.match(dockerfile, /^ARG BASE_TAG=dev$/m);
    assert.match(
      dockerfile,
      /^FROM paperclipai\/agent-runtime-base:\$\{BASE_TAG\}$/m,
    );
    assert.match(dockerfile, /^USER root$/m);
    assert.match(dockerfile, /export HOME=\/root/);
    assert.match(dockerfile, /NPM_CONFIG_CACHE=\/root\/\.npm/);
    assert.match(
      dockerfile,
      new RegExp(
        `npm install -g --no-audit --no-fund ${packageName.replaceAll("/", "\\/")}@[^\\s\\\\]+`,
      ),
    );
    assert.match(dockerfile, /chown -R 0:0/);
    assert.match(dockerfile, /chmod -R go-w/);
    assert.match(dockerfile, /^USER 1000:1000$/m);
    assert.match(
      dockerfile,
      new RegExp(`command -v ${command.replaceAll("-", "\\-")} >\\/dev\\/null 2>&1`),
    );
    assert.match(dockerfile, /test "\$\(stat -c '%u:%g'/);
    assert.match(dockerfile, /test ! -w/);
    assert.doesNotMatch(dockerfile, /chown\s+-R\s+1000:1000\s+\/(?:usr|opt)/);
  }
});

test("bake keeps all existing runtime targets and chains them to base", () => {
  const bake = read("buildx-bake.hcl");
  const expected = ["base", "claude", "codex", "gemini", "opencode", "pi", "hermes"];
  const defaultGroup = bake.match(/group "default"\s*\{\s*targets\s*=\s*\[([^\]]+)]/s);
  assert.ok(defaultGroup, "default bake group is present");
  const targets = [...defaultGroup[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(targets, expected);

  const definedTargets = [...bake.matchAll(/^target "([^"]+)"/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(definedTargets, expected);

  for (const [name] of realHarnesses) {
    assert.match(
      bake,
      new RegExp(
        `target "${name}"[\\s\\S]*?"paperclipai/agent-runtime-base:\\$\\{VERSION\\}" = "target:base"`,
      ),
    );
  }
});

test("Hermes remains an explicit placeholder", () => {
  const hermes = read("Dockerfile.hermes");

  assert.match(hermes, /stub image preserves a cloud/);
  assert.match(hermes, /^USER 1000:1000$/m);
  assert.doesNotMatch(hermes, /^RUN\b/m);
});

test("deployment policy and release machinery stay outside the image contract", () => {
  const combined = [
    read("Dockerfile.base"),
    read("README.md"),
    read("buildx-bake.hcl"),
  ].join("\n");

  assert.doesNotMatch(combined, /paperclip-guardrails|external-pr-approved|gh-wrapper/);
  assert.doesNotMatch(combined, /release-manifest|MANIFEST_CHECKSUM/);
  assert.match(combined, /TrueNAS image publication[\s\S]*deployment configuration/);
});
