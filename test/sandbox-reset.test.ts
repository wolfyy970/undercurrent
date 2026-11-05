import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { resetIdentitySandbox } from "../src/api.ts";
import { containerNameFor, envDirFor, writeEnvMetadata } from "../src/sandbox-env.ts";
import { DockerSandbox } from "../src/sandbox-docker.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true }); });
const ID = "a".repeat(64);
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "identity-sandbox-reset-")));
  roots.push(root);
  const identity = path.join(root, "identity");
  fs.mkdirSync(identity);
  fs.writeFileSync(path.join(identity, "info.txt"), "name=pax\n");
  const state = envDirFor(identity, "pax");
  writeEnvMetadata(state, { containerId: ID, image: "test-image", varMounts: [] });
  const container = { Id: ID, Name: `/${containerNameFor("pax", state)}`, Mounts: [{ Type: "bind", Source: identity, Destination: identity, RW: true }] };
  const replies = path.join(root, "replies.json");
  const log = path.join(root, "docker.jsonl");
  const dockerPath = path.join(root, "docker");
  fs.writeFileSync(dockerPath, `#!${process.execPath}
const fs = require('node:fs');
const replies = JSON.parse(fs.readFileSync(process.env.RESET_REPLIES, 'utf8'));
const reply = replies.shift();
fs.writeFileSync(process.env.RESET_REPLIES, JSON.stringify(replies));
fs.appendFileSync(process.env.RESET_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (!reply) process.exit(98);
if (reply.mutateId) fs.writeFileSync(process.env.RESET_ID_FILE, reply.mutateId);
process.stdout.write(reply.stdout || '');
process.exit(reply.status || 0);
`, { mode: 0o755 });
  return { root, identity, state, container, opts: { dockerPath, env: { ...process.env, RESET_REPLIES: replies, RESET_LOG: log, RESET_ID_FILE: path.join(state, "container_id") } }, script: (values: { stdout?: string; status?: number; mutateId?: string }[]) => fs.writeFileSync(replies, JSON.stringify(values)), calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [] };
}

describe("public identity sandbox reset", () => {
  it("removes only the verified recorded container and metadata, preserving identity files", () => {
    const f = fixture();
    f.script([{ stdout: JSON.stringify(f.container) }, {}]);
    resetIdentitySandbox(f.identity, "pax", f.opts);
    expect(f.calls()).toEqual([["inspect", "--format", "{{json .}}", ID], ["rm", "-f", ID]]);
    expect(fs.existsSync(f.state)).toBe(false);
    expect(fs.readFileSync(path.join(f.identity, "info.txt"), "utf8")).toBe("name=pax\n");
  });

  it("does not require Docker when sandbox metadata is absent", () => {
    const f = fixture();
    fs.rmSync(f.state, { recursive: true });
    resetIdentitySandbox(f.identity, "pax", { dockerPath: path.join(f.root, "not-installed") });
    expect(f.calls()).toEqual([]);
  });

  it("accepts an aliased identity path only when sandbox state is absent", () => {
    const f = fixture();
    const alias = path.join(f.root, "identity-alias");
    fs.symlinkSync(f.identity, alias);
    expect(() => resetIdentitySandbox(alias, "pax", f.opts)).toThrow(/canonical/);
    fs.rmSync(f.state, { recursive: true });
    resetIdentitySandbox(alias, "pax", f.opts);
    expect(f.calls()).toEqual([]);
  });

  it("accepts an already-removed container only after Docker confirms its absence", () => {
    const f = fixture();
    f.script([{ status: 1 }, { stdout: "" }]);
    resetIdentitySandbox(f.identity, "pax", f.opts);
    expect(f.calls()[1]).toEqual(["ps", "-a", "-q", "--no-trunc", "--filter", `id=${ID}`]);
    expect(fs.existsSync(f.state)).toBe(false);
    expect(f.calls().some((args) => args[0] === "rm")).toBe(false);
  });

  it.each(["daemon-unavailable", "still-listed", "removal-failed", "invalid-json"])("preserves state when %s", (failure) => {
    const f = fixture();
    f.script(failure === "daemon-unavailable" ? [{ status: 1 }, { status: 1 }] : failure === "still-listed" ? [{ status: 1 }, { stdout: ID }] : failure === "invalid-json" ? [{ stdout: "not-json" }] : [{ stdout: JSON.stringify(f.container) }, { status: 1 }]);
    expect(() => resetIdentitySandbox(f.identity, "pax", f.opts)).toThrow();
    expect(fs.readFileSync(path.join(f.state, "container_id"), "utf8")).toBe(ID);
  });

  it.each(["name", "id", "source", "destination", "readonly", "non-bind"])("refuses a container with the wrong %s before removal", (field) => {
    const f = fixture();
    if (field === "name") f.container.Name = "/another-identity";
    if (field === "id") f.container.Id = "b".repeat(64);
    if (field === "source") f.container.Mounts[0]!.Source = f.root;
    if (field === "destination") f.container.Mounts[0]!.Destination = "/other";
    if (field === "readonly") f.container.Mounts[0]!.RW = false;
    if (field === "non-bind") f.container.Mounts[0]!.Type = "volume";
    f.script([{ stdout: JSON.stringify(f.container) }]);
    expect(() => resetIdentitySandbox(f.identity, "pax", f.opts)).toThrow(/does not belong/);
    expect(f.calls()).toHaveLength(1);
    expect(fs.existsSync(f.state)).toBe(true);
  });

  it.each(["identity", "directory", "file"])("rejects a symbolic link in the %s path", (where) => {
    const f = fixture();
    let identity = f.identity;
    if (where === "identity") { identity = path.join(f.root, "identity-link"); fs.symlinkSync(f.identity, identity); }
    if (where === "directory") { fs.renameSync(f.state, `${f.state}-kept`); fs.symlinkSync(`${f.state}-kept`, f.state); }
    if (where === "file") { fs.renameSync(path.join(f.state, "container_id"), path.join(f.state, "kept")); fs.symlinkSync(path.join(f.state, "kept"), path.join(f.state, "container_id")); }
    expect(() => resetIdentitySandbox(identity, "pax", f.opts)).toThrow(/canonical|symbolic|regular/);
    expect(f.calls()).toEqual([]);
  });

  it("rejects traversal, redirected state, invalid IDs and partial metadata without calling Docker", () => {
    const f = fixture();
    expect(() => resetIdentitySandbox(f.identity, "../pax", f.opts)).toThrow(/name/);
    expect(() => resetIdentitySandbox(f.identity, "pax", { ...f.opts, env: { ...f.opts.env, SHELLM_ENVS_DIR: f.root } })).toThrow(/remain under/);
    fs.writeFileSync(path.join(f.state, "container_id"), "not-a-container");
    expect(() => resetIdentitySandbox(f.identity, "pax", f.opts)).toThrow(/invalid/);
    fs.rmSync(path.join(f.state, "container_id"));
    expect(() => resetIdentitySandbox(f.identity, "pax", f.opts)).toThrow();
    expect(f.calls()).toEqual([]);
    expect(fs.existsSync(f.state)).toBe(true);
  });

  it("refuses state changed during Docker inspection before removing a container", () => {
    const f = fixture();
    f.script([{ stdout: JSON.stringify(f.container), mutateId: "b".repeat(64) }]);
    expect(() => resetIdentitySandbox(f.identity, "pax", f.opts)).toThrow(/changed during reset/);
    expect(f.calls()).toHaveLength(1);
    expect(fs.existsSync(f.state)).toBe(true);
  });
});

const image = "node:24-bookworm";
const realDocker = DockerSandbox.isDaemonAvailable() && spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 5000 }).status === 0;
it.skipIf(!realDocker)("removes a real Docker container with the exact identity bind", () => {
  const f = fixture();
  const name = f.container.Name.slice(1);
  const created = spawnSync("docker", ["create", "--name", name, "--mount", `type=bind,source=${f.identity},target=${f.identity}`, image, "sleep", "300"], { encoding: "utf8", timeout: 20_000 });
  expect(created.status, created.stderr).toBe(0);
  const id = created.stdout.trim();
  try {
    fs.writeFileSync(path.join(f.state, "container_id"), id);
    resetIdentitySandbox(f.identity, "pax");
    expect(spawnSync("docker", ["inspect", id], { stdio: "ignore", timeout: 5000 }).status).not.toBe(0);
    expect(fs.existsSync(f.state)).toBe(false);
  } finally { spawnSync("docker", ["rm", "-f", id], { stdio: "ignore", timeout: 5000 }); }
});
