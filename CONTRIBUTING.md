# Contributing to Undercurrent

Undercurrent is an unofficial TypeScript port of [laude-institute/headlong](https://github.com/laude-institute/headlong).
It was built entirely by AI agents, with one human ([@wolfyy970](https://github.com/wolfyy970)) steering and reviewing.
Contributions are welcome on the same terms, whether you wrote the change yourself or an AI agent wrote it for you.

## The rules

- **AI-written pull requests are welcome. Say so.** The pull request template has a disclosure line: tick it and name
  the tool or agent. Please don't hide it; a reviewer reads an AI-written change differently, and that's fine.
- **Quality is enforced by CI, not by who wrote the code.** A pull request is reviewed once every gate below is green.
  Nobody merges around a red gate.
- **Bring evidence.** The template asks for the commands you ran and what they printed (test counts, parity harness
  output). "Should work" is not evidence.
- **One change per pull request.** Every behavior change comes with a test that fails without it.
- **Parity with upstream, or a documented deviation.** A change either keeps the port behaving like upstream Headlong
  at the pin named in the README (ideally shown by the matching `parity/<tool>/` harness run) or records the deviation,
  and why, in `PARITY.md`.
- **Coding agents start at [`AGENTS.md`](./AGENTS.md).** It points to the porting method, the test rules and the
  definition of done.
- **No secrets or personal data.** Never commit API keys, tokens, `.env` files, home-directory paths or personal
  details. CI runs gitleaks and `test/scrub.test.ts`, but they are a net, not a substitute for looking.
- **Security problems go through [`SECURITY.md`](./SECURITY.md)** (a private GitHub vulnerability report), never a
  public issue or pull request.
- **Best effort.** Issues and pull requests are handled as time allows. There is no support or response-time promise.
- **License.** Contributions are accepted under Apache-2.0 (see `LICENSE`). Keep the credit to upstream Headlong in
  `NOTICE` and in each ported module's header.

## CI gates

Every push and pull request runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

| Gate | Command |
| --- | --- |
| Types | `pnpm typecheck` and `cd web/server && npm ci && npm run typecheck` |
| Tests | `pnpm test` (deterministic: no API key, no network; Docker-backed tests skip when no daemon answers) |
| Personal data | `test/scrub.test.ts` (part of `pnpm test`) |
| Secrets | gitleaks over the full git history, with [`.gitleaks.toml`](.gitleaks.toml) allowlisting the fake keys in redaction tests |

## Wanted: an engineer co-maintainer

This project is maintained by one person working with AI agents. If you are an engineer who would like to help review
pull requests, keep the parity method honest or own CI, open an issue titled "Co-maintainer" with a line about
yourself. Experience with TypeScript, Node and agent runtimes helps; Python helps for reading upstream.

## Development setup

```bash
git clone https://github.com/<you>/undercurrent.git   # your fork
cd undercurrent
pnpm install                                           # Node 22.18+ (see .nvmrc); Bun optional
pnpm typecheck && (cd web/server && npm ci && npm run typecheck)
pnpm test                                              # deterministic: no API key, no network
```

Parity harnesses need an upstream Headlong checkout; see `docs/GUIDE.md` ("Tests and parity"). Run the harness for the
tool you changed and paste what it reported into the pull request.
