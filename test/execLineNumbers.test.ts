// execLineNumbers.test.ts — the model's block must sit at the SAME line numbers inside the bash
// script as upstream's. bash prints "line N:" in error text (unknown command, syntax error) and
// `$LINENO` in the model's own code from that numbering, so one extra leading line (the port's old
// `exec 2>&1\n`) made every number +1 versus bin/shellm (found by the stage-6b gapcheck on the box:
// "port reports line 3 where upstream reports line 2").
//
// Oracle: upstream runs `bash -e -c "$wrapped_code"` (bin/shellm:1631) with
// wrapped_code = "set -x\n$code\nset +x\n\n__shellm_rc=$?..." (bin/shellm:3065-3068). We run exactly that
// shape with the SAME bash (so bash-version numbering differences cancel out) and demand the
// port's LocalSandbox + buildWrappedCode print the same text. The real-upstream differential is
// parity/execlines/run-parity.mjs.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { buildWrappedCode } from "../src/shellm.ts";
import { LocalSandbox } from "../src/sandbox.ts";

/** Upstream's wrapper, written out from bin/shellm:3065-3073 (final path unquoted-equivalent). */
function upstreamWrapped(code: string, finalPath: string): string {
  return `set -x\n${code}\nset +x\n\n__shellm_rc=$?\nset +e\n[ -n "\${FINAL+x}" ] && printf '%s' "$FINAL" > "${finalPath}"\n[ -n "\${FINAL_FILE+x}" ] && cat "$FINAL_FILE" > "${finalPath}"\nexit $__shellm_rc\n`;
}

/** Run upstream's invocation: bash -e -c "$wrapped" with stderr merged, as bin/shellm's `2>&1` does. */
function runUpstreamShape(wrapped: string, cwd: string): { out: string; exit: number } {
  const r = spawnSync("bash", ["-e", "-c", wrapped], { cwd, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), exit: r.status ?? -1 };
}

const FINAL = "/tmp/execlines-test-final-unused";
const noXtrace = (s: string) => s.split("\n").filter((l) => !/^\+\+? /.test(l)).join("\n");

describe("block line numbers match upstream's bash -e -c shape", () => {
  const cases: Array<[string, string]> = [
    ["unknown command, line 2 of the block", "echo one\nno_such_cmd_q arg\necho three"],
    ["unknown command, first line", "no_such_cmd_q\necho two"],
    ["syntax error mid-script", "echo one\necho two\nif then fi\necho four"],
    ["syntax error: stray paren", "echo one\nfoo ) bar"],
    ["unterminated if (error reported at EOF + opener line)", "echo one\nif true; then\n  echo two"],
    ["unterminated quote (wrapper's own quotes pair with it)", "echo one\necho 'two\nthree"],
    ["$LINENO printed by the block", "echo $LINENO\n\necho $LINENO"],
    ["heredoc then unknown command", "cat <<'X'\nh1\nX\nno_such_cmd_q"],
  ];
  for (const [name, code] of cases) {
    it(name, async () => {
      const wd = fs.mkdtempSync(path.join(os.tmpdir(), "execlines-"));
      try {
        const oracle = runUpstreamShape(upstreamWrapped(code, FINAL), wd);
        const port = await new LocalSandbox().exec({
          workdir: wd,
          wrappedCode: buildWrappedCode(code, FINAL),
          env: { PATH: process.env["PATH"] ?? "" },
        });
        expect(port.exit).toBe(oracle.exit);
        expect(noXtrace(port.output)).toBe(noXtrace(oracle.out));
      } finally {
        fs.rmSync(wd, { recursive: true, force: true });
      }
    });
  }

  it("the script handed to bash starts at line 1 with set -x (no leading line of its own)", () => {
    const w = buildWrappedCode("echo hi", "/tmp/f");
    expect(w.startsWith("set -x\necho hi\nset +x\n\n__shellm_rc=$?\n")).toBe(true);
  });

  it("a plain unknown command in line 2 of the block is reported on script line 3 (set -x is line 1)", async () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "execlines-"));
    try {
      const r = await new LocalSandbox().exec({
        workdir: wd,
        wrappedCode: buildWrappedCode("echo one\nno_such_cmd_q", FINAL),
        env: { PATH: process.env["PATH"] ?? "" },
      });
      // bash 3.2 (macOS /bin/bash) numbers -c lines from 0; every newer bash from 1.
      const m = /line (\d+): no_such_cmd_q: command not found/.exec(r.output);
      expect(m).not.toBeNull();
      const ref = /line (\d+): no_such_cmd_q/.exec(runUpstreamShape("set -x\necho one\nno_such_cmd_q\n", wd).out);
      expect(Number(m![1])).toBe(Number(ref![1]));
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe("FINAL capture still works through the double-quoted final path", () => {
  it("writes FINAL to a path containing a space, a quote and a dollar sign", async () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), "execlines-"));
    try {
      const finalPath = path.join(wd, 'we ird "q" $HOME `x` \\final');
      const r = await new LocalSandbox().exec({
        workdir: wd,
        wrappedCode: buildWrappedCode("FINAL=done-ok", finalPath),
        env: { PATH: process.env["PATH"] ?? "" },
      });
      expect(r.exit).toBe(0);
      expect(fs.readFileSync(finalPath, "utf8")).toBe("done-ok");
    } finally {
      fs.rmSync(wd, { recursive: true, force: true });
    }
  });
});
