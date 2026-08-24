---
name: connecting-services
description: How to connect the assistant to something new — an MCP server, another model endpoint, or a service that needs a credential. Use whenever the user says "connect X", "set up X", "add X", asks what you can connect to, or offers you a token, key or password.
---

# Connecting something new

Everything here goes through `setup.form`: a form appears inline in the
conversation, the user fills it in, and your run resumes with the result.
**Never take a credential as chat text** — a value typed into a form goes
straight to `secrets/secrets.yaml` and you are handed only a `${secret:KEY}`
reference.

## The shape of it

1. **Work out what they mean.** "Connect the GitHub MCP" is an MCP server; "add
   my other llama.cpp box" is a model endpoint. Ask only what you cannot infer.
2. **Research if you need to.** If you do not know the exact install command or
   URL for a connector, find it with `web.search` and `web.fetch`. A wrong
   command in a form field wastes the user's time; guessing is worse than
   looking.
3. **Pick the template** and **prefill everything you know** — the user should
   be reading and confirming, not typing what you already established:

   | template | for | fields you normally prefill |
   |---|---|---|
   | `mcp_stdio` | an MCP server that runs as a local command | `name`, `description`, `command`, `env_var` |
   | `mcp_http` | an MCP server behind a URL | `name`, `description`, `url` |
   | `model_endpoint` | another OpenAI-compatible model | `name`, `url` |
   | *(no template)* | anything else you need structured input for | all of them |

   Prefill by passing `fields` entries with the same `name` as the template's:
   `fields: [{name: "name", value: "github"}, {name: "description", value: "GitHub issues, PRs and code search"}, {name: "command", value: "npx -y @modelcontextprotocol/server-github"}, {name: "env_var", value: "GITHUB_PERSONAL_ACCESS_TOKEN"}]`.
   Leave the secret field alone — it is the user's to type. `description` is
   worth filling: it becomes the one line you will see about this server in
   later conversations, when its tools are paged out.
4. **Summon the form** with a title that says what is about to happen.
5. **Read the outcome.** `effect` reports what the server-side step did: whether
   it installed, whether it connected, and which tools it now serves.
   `submitted: false` means the user cancelled or it timed out — say so and
   stop; do not re-summon the same form unasked.
6. **Ask for access to the new tools.** Connecting a server does not grant you
   its tools — `installed: true, granted: false` in the outcome means exactly
   that, and calling one anyway comes back `unknown_tool`. Call
   `setup.request_access {tools: ["<server>.*"], reason: ..., description: ...}`
   straight away. The user sees every tool and what it does, and approves once.
7. **Report the new tools by name**, then offer to write a skill that wraps
   them. A bare tool list is not usable knowledge; a short skill saying *when*
   to reach for those tools is what makes the connection worth having. Write it
   with `config.write` to `skills/<name>.md`.

## Turning on something that ships with you

Asana and Google Calendar are already built in — they just ship switched off,
because they need a credential. Do not reach for a template for these:

1. `setup.list_integrations` tells you what exists, what is active, and what
   each one provides. Use it before promising anything, and to answer "what can
   you connect to" and "what are you connected to".
2. `setup.activate {integration}` shows its own form, checks the credential
   against the live service, and turns it on — its tools work in this same
   conversation, no restart. Prefill with `prefill: {field: value}`.
3. An `oauth` integration (Google Calendar) comes back `pending: true` with an
   `auth_url`. Give the user the link and say the setup finishes by itself when
   they approve; you will *not* be told here. Do not wait, and do not poll.
4. `setup.deactivate {integration}` switches one off. The credential is kept, so
   turning it back on later is one confirmation — say so, since "deactivate"
   otherwise sounds like it threw the token away.

## Things that will bite you

- **You cannot install an MCP server any other way.** `config/mcp.yaml` is not
  writable by `config.write`, by design: a local command is arbitrary code, so a
  human reading that command in a form field is the approval gate. There is no
  way around it, so do not look for one.
- **A failed connection is rolled back**, so `installed: false` means nothing
  was left behind. Read the `error`, tell the user what it said, and suggest the
  next thing to try.
- **A form needs a chat channel.** `reason: "no_channel"` means nobody is
  connected to render one — that only happens outside chat.
- **Connected is not callable.** `setup.list_integrations` reports `granted`
  per server and an `ungranted_tools` list. If a tool you want is in there, ask
  for it — do not report to the user that the connection failed, because it did
  not.
- **One form at a time.** Finish or abandon one before summoning the next.
- **An MCP server is not the answer for something already built in.** Check
  `setup.list_integrations` before proposing one.
- **A grant is permanent; being loaded is not.** Once access is approved the
  server's tools are yours for good, but a *new* conversation starts with them
  paged out — one catalog line under "Tool namespaces not loaded". Open it with
  `tools.open` (or just call the tool, which opens it for you). `unknown_tool`
  means ungranted; a name missing from your tool list usually just means closed.

*(Shipped with Turminder. Edit it freely — it is only re-created when missing.)*
