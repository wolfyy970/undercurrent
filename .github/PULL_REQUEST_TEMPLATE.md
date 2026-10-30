## What and why

<!-- One change per pull request. What does it change, and why? Link the issue if there is one. -->

## AI disclosure

- [ ] Written with AI assistance. Tool or agent: <!-- e.g. the agent and model -->
- [ ] Written without AI assistance

## Evidence

<!-- Paste what you ran and what it printed. Test counts, not "tests pass". -->

```text
$ pnpm typecheck
$ pnpm test
```

Parity: <!-- which parity/<tool>/ harness you ran against which upstream commit, and what it reported; or "n/a" -->

## Checklist

- [ ] CI is green (types, tests, scrub test, gitleaks)
- [ ] New or changed behavior has a test that fails without the change
- [ ] The port still matches upstream, or the deviation and its reason are in `PARITY.md`
- [ ] No secrets, API keys, `.env` files, home-directory paths or other personal data
- [ ] `CHANGELOG.md` updated under "Unreleased" if users would notice
