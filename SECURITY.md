# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (a private security advisory). Do not open a public issue or pull request for an unfixed
vulnerability, and do not include real API keys or other secrets in the report.

This is a best-effort project with no response-time promise; reports are looked at as time allows.

## Scope

Undercurrent runs shell commands written by a language model. By design, an identity can do anything its sandbox
allows. Run it in Docker (the default when a daemon is available) or another sandbox, use a dedicated, spend-capped API
key, and do not give an identity secrets it does not need. Reports about escaping the documented sandbox, leaking keys
into trajectories or logs, or the web control plane accepting requests it should not are in scope.

## Supported versions

Only the latest release on the default branch receives fixes.
