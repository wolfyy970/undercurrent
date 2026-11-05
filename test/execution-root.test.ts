import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as ts from "typescript";
import { getIdentityActivity, resolveIdentityEnv, verifyExecutionRoot, type VerifiedExecutionRoot } from "../src/api.ts";
import { executionArchive } from "./support/executionArchive.ts";

const root = path.resolve(import.meta.dirname, "..");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function archive(): string {
  const dir = executionArchive(root);
  temporary.push(dir);
  return dir;
}

describe("retained execution-root certificate", () => {
  it("accepts byte-identical engine execution with an older embedding API and release version", () => {
    const candidate = archive();
    fs.writeFileSync(path.join(candidate, "src/api.ts"), "// older embedding-only API\n");
    fs.rmSync(path.join(candidate, "src/activity.ts"));
    const pkg = path.join(candidate, "package.json");
    fs.writeFileSync(pkg, fs.readFileSync(pkg, "utf8").replace(/"version": "[^"\n]+"/, '"version": "0.0.9"'));
    const certificate = verifyExecutionRoot(candidate);
    expect(certificate).not.toBeNull();
    expect(Object.isFrozen(certificate)).toBe(true);
    expect(Object.keys(certificate!)).toEqual([]);
  });

  it.each(["src/daemon.ts", "src/assets/shellm-system-prompt.txt", "bin/dispatcherd.mjs", "tsconfig.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".nvmrc"])("rejects a changed execution input: %s", (relative) => {
    const candidate = archive();
    fs.appendFileSync(path.join(candidate, relative), "\n");
    expect(verifyExecutionRoot(candidate)).toBeNull();
  });

  it("rejects added and missing execution files, executable-bit changes, and unexpected root config", () => {
    const candidate = archive();
    const extra = path.join(candidate, "src/extra.ts");
    fs.writeFileSync(extra, "");
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.rmSync(extra);
    const command = path.join(candidate, "bin/dispatcherd.mjs");
    fs.chmodSync(command, 0o644);
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.chmodSync(command, 0o755);
    const config = path.join(candidate, "bunfig.toml");
    fs.writeFileSync(config, "[run]\n");
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.rmSync(config);
    fs.rmSync(command);
    expect(verifyExecutionRoot(candidate)).toBeNull();
  });

  it("permits read-only archive permissions", () => {
    const candidate = archive();
    fs.chmodSync(path.join(candidate, "bin/dispatcherd.mjs"), 0o555);
    fs.chmodSync(path.join(candidate, "src/daemon.ts"), 0o444);
    expect(verifyExecutionRoot(candidate)).not.toBeNull();
  });

  it("rejects changed read permissions on files and archive roots", () => {
    const candidate = archive();
    const file = path.join(candidate, "src/daemon.ts");
    fs.chmodSync(file, 0o400);
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.chmodSync(file, 0o644);
    fs.chmodSync(candidate, 0o700);
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.chmodSync(candidate, 0o555);
    expect(verifyExecutionRoot(candidate)).not.toBeNull();
    fs.chmodSync(candidate, 0o755);
  });

  it("rejects runtime dependencies and retained node_modules, including a dangling symlink", () => {
    const candidate = archive();
    const file = path.join(candidate, "package.json");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original.replace('"private": true,', '"private": true,\n  "dependencies": { "unproved": "1" },'));
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.writeFileSync(file, original);
    fs.mkdirSync(path.join(candidate, "node_modules"));
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.rmSync(path.join(candidate, "node_modules"), { recursive: true });
    fs.symlinkSync("missing-dependencies", path.join(candidate, "node_modules"));
    expect(verifyExecutionRoot(candidate)).toBeNull();
  });

  it("rejects retargeted, escaping, substituted and embedding-module symlinks", () => {
    const candidate = archive();
    const link = path.join(candidate, "bin/llm");
    fs.rmSync(link);
    fs.symlinkSync("chat.mjs", link);
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.rmSync(link);
    fs.symlinkSync(path.join(root, "bin/llm.mjs"), link);
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.rmSync(link);
    fs.symlinkSync("llm.mjs", link);
    fs.renameSync(path.join(candidate, "src"), path.join(candidate, "actual-src"));
    fs.symlinkSync("actual-src", path.join(candidate, "src"));
    expect(verifyExecutionRoot(candidate)).toBeNull();
    fs.rmSync(path.join(candidate, "src"));
    fs.renameSync(path.join(candidate, "actual-src"), path.join(candidate, "src"));
    fs.rmSync(path.join(candidate, "src/api.ts"));
    fs.symlinkSync("daemon.ts", path.join(candidate, "src/api.ts"));
    expect(verifyExecutionRoot(candidate)).toBeNull();
  });

  it("rejects a symlinked candidate root and a forged or invalidated certificate", () => {
    const candidate = archive();
    const link = path.join(temporary[0]!, "root-link");
    fs.symlinkSync(candidate, link);
    expect(verifyExecutionRoot(link)).toBeNull();
    fs.rmSync(link);
    const certificate = verifyExecutionRoot(candidate)!;
    expect(certificate).not.toBeNull();
    fs.appendFileSync(path.join(candidate, "src/daemon.ts"), "\n");
    expect(getIdentityActivity(candidate, { executionRoot: certificate })).toEqual({ active: false, thinkers: [] });
    expect(getIdentityActivity(candidate, { executionRoot: {} as VerifiedExecutionRoot })).toEqual({ active: false, thinkers: [] });
    expect(() => resolveIdentityEnv(candidate, { executionRoot: certificate })).toThrow("execution-root certificate");
  });

  it("resolves only execution PATH/home through a fresh certificate while keeping the identity environment", () => {
    const candidate = archive();
    const certificate = verifyExecutionRoot(candidate)!;
    expect(certificate).not.toBeNull();
    const base = { KEEP: "value", PATH: path.join(root, "bin") + path.delimiter + "/usr/bin" };
    const normal = resolveIdentityEnv(candidate, { base });
    const env = resolveIdentityEnv(candidate, { base, executionRoot: certificate });
    expect(env["HEADLONG_TS_HOME"]).toBe(candidate);
    expect(env["PATH"]?.split(path.delimiter)[0]).toBe(path.join(candidate, "bin"));
    expect(env["PATH"]?.split(path.delimiter)).not.toContain(path.join(root, "bin"));
    const { PATH: normalPath, HEADLONG_TS_HOME: normalHome, ...normalIdentity } = normal;
    const { PATH: retainedPath, HEADLONG_TS_HOME: retainedHome, ...retainedIdentity } = env;
    expect(retainedIdentity).toEqual(normalIdentity);
  });
});

describe("execution graph excludes embedding APIs and runtime dependencies", () => {
  it("imports only builtin node modules and literal source paths inside bin/src", () => {
    const excluded = new Set([path.join(root, "src/api.ts"), path.join(root, "src/activity.ts")]);
    const visitFile = (file: string): void => {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) { for (const name of fs.readdirSync(file)) visitFile(path.join(file, name)); return; }
      if (excluded.has(file)) return;
      const text = fs.readFileSync(file, "utf8");
      if (!/\.(ts|mjs|js)$/.test(file) && !text.startsWith("#!/")) return;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const check = (specifier: ts.Expression): void => {
        expect(ts.isStringLiteral(specifier), `${file}: computed module import`).toBe(true);
        if (!ts.isStringLiteral(specifier)) return;
        if (specifier.text.startsWith("node:")) return;
        expect(specifier.text.startsWith("."), `${file}: external dependency ${specifier.text}`).toBe(true);
        const target = path.resolve(path.dirname(file), specifier.text);
        expect(excluded.has(target), `${file}: embedding API imported by execution`).toBe(false);
        expect(target.startsWith(path.join(root, "src") + path.sep) || target.startsWith(path.join(root, "bin") + path.sep), `${file}: import outside certified source`).toBe(true);
        expect(fs.existsSync(target), `${file}: missing import target`).toBe(true);
      };
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node.moduleSpecifier);
        if (ts.isCallExpression(node)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
            expect(node.arguments.length).toBe(1);
            if (node.arguments[0]) check(node.arguments[0]);
          }
          if (ts.isIdentifier(node.expression)) expect(["eval", "createRequire"].includes(node.expression.text), `${file}: dynamic module loader`).toBe(false);
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) expect(node.expression.text).not.toBe("Function");
        ts.forEachChild(node, visit);
      };
      visit(source);
    };
    visitFile(path.join(root, "bin"));
    visitFile(path.join(root, "src"));
  });
});
