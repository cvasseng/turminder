# Turminder

A self-hosted, event-driven personal assistant that runs on your own
hardware — against a local model, or any endpoint you point it at. Named
after Turminder Xuss,
the drone in Iain M. Banks' *Matter* — the software is the drone; your
instance names itself after a Culture Mind when you first meet it.

## Why another assistant system?

The usual shape for an assistant is one always-on agent with broad standing
permissions, where whatever it reads — your mail, a webpage, an installed
skill — arrives in the same context that decides what to *do*. It gets you
something useful quickly, and asks in return that the model keep track of
which of the things in front of it were instructions.

Turminder makes the opposite bet, and the trade is real — more setup, more
ceremony, fewer things that happen on their own:

- **Events in, one gate to action.** Everything is an event on one loop —
  mail, chat, timers, file changes, button clicks. An LLM classifier routes
  events to *handlers*: small markdown behaviors **you** authored, each
  with an explicit tool grant. External content can only ever *say*
  things; only your handlers can *do* things, and only with the tools
  their frontmatter names.
- **Capability is enforced, not prompted.** Grants live in the tool
  dispatcher, not in instructions the model might ignore. Three levels per
  tool: invisible, human-confirmed per call, or auto. Untrusted content
  (mail bodies, web results, tool output from external servers) is fenced
  as data in every prompt.
- **Secrets never enter model context.** Credentials go through forms in
  the chat UI straight into the secret store — your OS keychain, a
  GPG-encrypted file, or a chmod-600 file, your choice; the model only ever
  sees a `${secret:KEY}` reference. 
- **Numbers you can trust.** Documents and dashboards pull live data
  through *bindings* — frozen read-only tool calls replayed by
  deterministic code. Values never pass through the model's token stream,
  so they can't be hallucinated or mistranscribed; every figure is
  auditable to the call that fetched it.
- **Installing capability is a human act.** No skill marketplace. MCP
  servers are installed only through a form you submit with the exact
  command in front of you; an agent can propose a connection, never
  perform one.
- **Local-first, small-model honest.** Built for local models: aggressive
  context discipline (tool paging, transcript elision, prompt-cache-stable
  assembly) makes a 32k-context model on your own hardware genuinely
  usable. Any OpenAI-compatible endpoint works.
- **Everything is auditable.** Every event carries a full trace — what
  matched and why, every model call, every tool call. The assistant's
  self-modifications (memories, handlers, skills) are git commits in your
  data directory. "Why did it do that" always has an answer.
- **Your data is a folder.** One directory is the complete state:
  human-readable markdown under git, plus one SQLite file. Copy it to a
  new machine and it's the same assistant. Default bind is localhost.

## So who is this for?

For people who want an assistant that does what they've allowed it to do,
when they allowed it to do it — and nothing else. You'd rather spend a
minute saying yes than wonder what it got up to while you weren't looking,
and when something does surprise you, "why did it do that" should get an
answer, not a shrug.

None of that control costs you an evening in a settings page. Want a new
behavior, a routine, a connection to an outside service? Ask. Your
assistant sets it up with you in chat, requests exactly the permissions
the new thing needs, and remembers the arrangement. No obscure config
files, no head-scratching — and nothing gains a capability behind your
back.

If you want the opposite — maximum capability out of the box, skills that
install themselves, an agent that acts first and explains never — this
will feel like filling out paperwork. The ceremony *is* the product:
nothing acts until you have said, once and durably, what it may do.

## What it can do

- **Chat** — simple web UI with streaming, tool use, and a conversational
  first-run: once a model is configured the assistant opens the conversation
  itself, names itself, and learns your preferences.
  Drop an image in and a vision-capable model looks at it; one that cannot
  says so rather than guessing.
- **React to events with handlers** — "when an invoice mail arrives, file
  it"; authored in chat as markdown, matched by an LLM ingress, executed
  with only the tools you granted.
- **Remember** — markdown memory files with RAG retrieval, distilled from
  conversations, every change a git commit; past conversations are
  searchable too ("what did we decide about the dashboard?").
- **Shared files** — a workspace of notes and todo lists (point it at an
  Obsidian vault); type `@turminder do X` in any file and it becomes an
  event. Images and PDFs preview in the panel.
- **Schedule** — reminders and recurring work, with desktop notifications
  through a bundled or remote daemon, including approve/deny buttons for
  gated actions.
- **Watch** — "track this package": a status checked on a timer by plain
  code, which wakes the model only when the answer changes. The history is
  a file in your workspace; a delivered parcel closes its own watch.
- **Integrations** — Asana, Google Calendar, weather (yr.no/MET), time,
  web search (SearXNG) and page fetching built in; anything else via MCP
  servers, connected through chat with form-based credential entry.
- **Embeds** — the assistant writes small sandboxed HTML pages: charts
  (Highcharts), dashboards with live data bindings, reveal.js
  presentations, and mini-apps whose buttons fire events your handlers
  act on. Iterated in chat, served standalone with scoped tokens.
- **Documents** — read PDFs and Word documents (outline first, then the
  pages or sections that matter — a tracked-changes .docx reads as its
  final text); export any embed or markdown file to PDF via headless
  chromium — the PDF is the exact page you previewed.
- **Connect your other devices** — press connect on the new one, approve
  the prompt that appears on an old one, and a phone is talking to your
  assistant; or scan a QR the assistant makes for you, which it can do
  without ever seeing the token. Only hashes are stored, so revoking a
  device is instant and a lost token is replaced rather than recovered. The
  UI is built for the phone that arrives that way: the conversation gets the
  whole screen, and the sidebar and panels slide over it when you ask for
  them.
- **A desktop app** (Linux) — the same UI in its own window, with a tray
  icon and reminders that arrive as native notifications while the window
  is closed. On first run it asks where the assistant should run: on this
  computer, where the app carries its own Node runtime and looks after the
  service for you, or on a machine you already run it on, which you point
  it at with a connect link. Its key lives in your keyring, never in a
  file. Built from `app/` with nix; macOS and Windows are not built yet.
- **A browser extension** — open a page, click, and read the exact text
  that will be sent before it goes: extraction, a note field, Send. It
  cannot read a page until you invoke it on that one, and the note you type
  is the only part treated as an instruction — the page's own words never
  are.
- **Know what it costs, and who answered** — price your endpoints and every
  chat shows an estimate; ask "what have you cost me this month?" in chat.
  With more than one model configured, a selector picks who answers this
  conversation, and every call records which endpoint served it and why. An
  endpoint that declares reasoning levels gets a second control beside it —
  and an endpoint that declares none is never sent the knob.
- **Projects** — a fenced island of files, memories and past conversations.
  Load one when you start working on it; until you do, nothing inside it
  reaches a prompt, because the search itself is scoped. Notes written while
  it is loaded are filed inside it.
- **Inspect everything** — `turminder events show`, tool/grant listings,
  replayable traces.

## How to run it

Prerequisites: Node ≥ 22, and any OpenAI-compatible endpoint — a locally
served model, or a hosted provider whose key you paste into setup.
Handling tool calls well matters more than size: development and testing
run against a locally served **Qwen3.8 27B**, which is what the context
discipline is tuned against. Git is
optional: without it everything works except the change history over your
files.

```sh
git clone <this repo> && cd turminder
npm install
npm run dev            # starts the service on http://127.0.0.1:7787
```

Open `http://127.0.0.1:7787`:

1. **Setup** — pick your provider from the dropdown (Anthropic, OpenAI,
   Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Together, Ollama,
   llama.cpp) and it fills in the base URL, or choose Custom and type your
   own. Nothing is taken on trust: it probes what the endpoint can actually
   do before writing any config.
2. **Onboarding** — the assistant introduces itself, picks a name, asks
   yours, and writes its own identity files. Renaming it later is one
   request away: it rewrites its own identity and points out where the
   old name still lingers.
3. Talk to it. Connect services with "set up asana" / "set up google
   calendar", or install MCP servers by asking.

Everything it knows lives in `~/.turminder` (override with `--data-dir`
or `TURMINDER_DATA_DIR`) — a git repo of markdown plus `events.db`. Back
it up by copying the folder.

Optional:

```sh
npm run daemon         # desktop notifications on another machine (WS, token auth)
npm run app:build      # the Linux desktop app (needs nix; see app/README.md)
npm run build:extensions   # the browser extension, per browser under dist/extension/
npm test               # the full suite
```

To keep it running across reboots, a systemd user unit ships in
`contrib/systemd/` — `npm run build`, copy the unit to
`~/.config/systemd/user/`, point its `WorkingDirectory` at your clone, and
`systemctl --user enable --now turminder`. The header comments cover the
rest (start at boot, headless secret backends).

Connecting another device takes one button on the new device and one
prompt on an old one. Open the chat on the phone (or the extension's
options page) and press **connect this device**: it shows a short code, and
a dialog appears on a device that is already linked carrying the same code
and a field for what to call the new one. Check that the codes match, name
it, approve — and the new device lets itself in. Nothing to type, nothing
to scan, and the assistant never sees the token.

The other directions still work. Ask the assistant to connect a device and
it answers with a one-time link and QR code; if no screen is free to show a
prompt, say "connect this device, the code is K7M-P42" and it approves that
way. The CLI (`npx tsx src/index.ts token create phone --qr`) is for a
headless first run, before anything is connected — the one moment there is
nobody to ask.

For LAN access, set `bind: 0.0.0.0:7787` in `~/.turminder/config/turminder.yaml`
and put it behind Tailscale/WireGuard — device tokens are the only gate,
and traffic is plain HTTP. Set `gateway.public_url` to the address other
devices should use, or the QR codes will guess it from your interfaces.

## License

MIT — see [LICENSE](LICENSE).

---

Architecture and contracts live in [spec.md](spec.md).
