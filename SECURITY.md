# Security

Turminder runs on your own machine and holds the credentials for whatever
you connected it to. The threat model that actually drives the design is in
[spec.md §14](spec.md#14-security); the short version is that the primary
threat is prompt injection, because this thing reads untrusted content,
holds private data, and can act externally.

## Reporting something

Use GitHub's private reporting: **[Security → Report a vulnerability](https://github.com/cvasseng/turminder/security/advisories/new)**.
It's enabled on this repo, the thread stays private until there's a fix, and
it keeps the report attached to the code instead of buried in a mailbox.
Please don't open a public issue for anything that looks exploitable.

Say what you did, what happened, and which commit (`git rev-parse HEAD`, or
the nightly's date). A proof of concept is worth more than a description of
one.

This is one person on a pre-release project: no bounty, no promised response
time. You'll get an acknowledgement and credit in the changelog unless you'd
rather not have it.

## In scope

The service, the desktop shell, and the browser extension in this repo.
The bugs worth hunting:

- A secret reaching a tool result, a log line, a git commit, or model
  context. Secrets are supposed to travel only as `${secret:KEY}`
  references, and only `core/secret-store` should touch `secrets/` (§27).
- Untrusted content becoming an instruction the assistant acts on. Payloads
  are fenced as data, the ingress agent has no tools, and handlers have
  mechanical capability allowlists (§14.2) — a way past any of those is the
  most interesting thing you could send me.
- Reaching the HTTP API without a device token, or obtaining a token you
  weren't granted (§24).
- Escaping an embed. LLM-authored pages are served sandboxed, with a CSP
  that gives them no network reach beyond their own scoped endpoint (§22.3).

## Not in scope

- Binding to `0.0.0.0` on a network you don't trust. The default is
  `127.0.0.1:7787`; widening it is your call and the docs say what it costs.
- The assistant doing something a handler was granted permission to do.
  That's the grant working as designed — change the grant.
- Anything that needs write access to `~/.turminder` or the machine itself.
  Whoever has that has already won, and §14.1 says so.
- Dependency advisories with no demonstrated path to exploitation here.
  Show me the path and it's a finding; a scanner's output on its own isn't.

## Versions

There's `main` and the rolling `nightly` built from it, and nothing else.
Fixes land on `main` — there are no release branches to back-port to.
