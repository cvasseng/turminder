# Design

Why Turminder is shaped the way it is. The mechanisms named here are
specified in [spec.md](../spec.md); the section references point there.

## The bet

The usual shape for an assistant is one always-on agent with broad standing
permissions, where whatever it reads (your mail, a webpage, an installed
skill) arrives in the same context that decides what to do. That gets you
something useful quickly, and asks in return that the model keep track of
which of the things in front of it were instructions.

Turminder makes the opposite bet. The trade is real: more setup, more
ceremony, fewer things that happen on their own.

## One loop, one gate

Everything is an event on one loop: mail, chat, timers, file changes, button
clicks in an embed. An LLM classifier routes each event to a handler, which
is a small markdown behavior you authored, with an explicit tool grant in its
frontmatter. External content arrives as data. Only handlers act, and only
with the tools their frontmatter names (§4, §5).

## Grants

Grants live in the tool dispatcher rather than in instructions the model
might ignore. Every tool sits at one of three levels for a given handler:
invisible, confirmed by a human per call, or automatic (§11.3). Untrusted
content, meaning mail bodies, web results and output from external MCP
servers, is fenced as data in every prompt (App. H.2).

## Secrets

Credentials go through forms in the chat UI straight into the secret store,
which is your OS keychain, a GPG-encrypted file, or a chmod-600 file. The
model only ever sees a `${secret:KEY}` reference, and one module is allowed
to read the values (§27).

## Bindings

Documents and dashboards pull live data through bindings, which are frozen
read-only tool calls replayed by deterministic code. Values never pass
through the model's token stream, so every figure on a dashboard is
auditable to the call that fetched it (§23.2).

## Installing capability

There is no skill marketplace. An MCP server is connected through a form you
submit with the exact command in front of you. An agent can propose a
connection; a person performs it (§19).

## Traces

Every event carries a trace of what matched and why, every model call, and
every tool call. Payloads are kept for 90 days. The assistant's changes to
itself, meaning memories, handlers and skills, are git commits in your data
directory, so "why did it do that" has an answer (§13).

## Local models

The context rules exist so a model on your own hardware can run the same
loop a hosted frontier model does. A run is budgeted at 30,000 tokens across
10 turns. Tool results are capped at 4,000 characters where they enter the
transcript, and results over 2,000 characters are elided once they are two
assistant turns old. Of 54 built-in tools, only 8 namespaces are in the
prompt at the start of a chat; the rest are opened on demand by the model.
Reasoning tokens are never fed back as context, and the prompt is assembled
so the volatile parts sit at the tail, which keeps the llama.cpp prefix
cache valid across turns (§20, §21).

Three test files guard these invariants (`context-discipline`,
`context-economics`, `reasoning`). Loosening one of them is how the
discipline would quietly disappear.

## Your data is a folder

One directory holds the complete state: human-readable markdown under git,
plus one SQLite file. Copy it to another machine and it is the same
assistant. The default bind is localhost.

## Who this is for

People who want an assistant that does what they have allowed it to do, when
they allowed it, and nothing else. You would rather spend a minute saying yes
than wonder what it got up to while you were not looking.

Saying yes does not mean an evening in a settings page. Ask for a new
behavior, a routine or a connection to an outside service, and the assistant
sets it up with you in chat, requests exactly the permissions the new thing
needs, and remembers the arrangement.

If what you want is maximum capability out of the box, with skills that
install themselves and an agent that acts first and explains never, this will
feel like filling out paperwork. Nothing here acts until you have said, once
and durably, what it may do.
