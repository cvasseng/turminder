 # Next

 * A Stop button. While the assistant is answering, a stop button sits beside
   Send (Esc does the same); pressing it ends the answer mid-word. What it had
   already said stays in the conversation — you watched it stream, it is yours
   — and a stopped question is settled, not retried behind your back. Stopping
   something that already finished quietly succeeds.

 * The assistant can be talked to. Hold a key in the desktop app, say something,
   let go, and it answers out loud — or turn on the wake word and just say its
   name. What it heard and what it said become an ordinary conversation, listed
   and searchable beside the typed ones, and the speaker starts on the first
   sentence rather than waiting for the whole answer. Speaking to it is chat
   with a different mouth: the same tools, the same permissions, the same
   record. Anything that needs your approval still asks on a screen.

 * The desktop app shows what it is doing while you talk to it: a small window
   that says it is listening, then what it heard — within a fraction of a
   second, long before the answer — then that it is working, then that it is
   answering. It used to show nothing at all.

 * A spoken answer that takes a while now says so out loud, once, rather than
   leaving the room in silence wondering whether it heard you. A quick answer
   still just answers.

 * "Talk to it" in the tray starts a spoken turn with no key held and no wake
   word — the way in before you have set either up, and on a machine where
   something else already owns the hotkey. It listens until you stop talking,
   and says "Stop listening" while it does if you change your mind.

 * The wake word is trained on your own voice, on your own machine: say the
   assistant's name five times and it learns that, in whatever language it is —
   no model download, nothing recorded kept, and nothing leaves the computer
   until you have actually triggered it. After a reply you have a few seconds to
   ask a follow-up without saying the name again.

 * The desktop app picks its microphone and speaker explicitly — both are in the
   tray, both are remembered, and one that will not open falls back to one that
   does and says so rather than listening to nothing. It opens the microphone
   once and shares it, so the wake word, a turn you started, and the moment
   after a reply are not three programs fighting over one device; and when
   nothing is listening, nothing is open.

 * Quiet mode in the tray silences the whole app: no notifications, no spoken
   replies, no chime. Whatever arrives while it is on comes back when you switch
   it off, in order, unless it expired in the meantime — nothing is dropped and
   nothing is faked.

 * The desktop app connects to a remote instance even on a machine with no
   keyring. It keeps the connection for that run only and says so, rather than
   refusing outright — the token still never touches disk, which is the point
   of the keyring in the first place.

 * When the desktop app cannot do something, it now says what happened, what
   follows from it, and what would fix it. "Platform secure storage failure:
   DBus error: The name is not activatable" and "Connection refused (os error
   111)" were both true and neither was any use.

 * The desktop app can be pointed at a different instance without reinstalling:
   "Connect to another instance…" is in the tray, and the connect screen offers
   to run it here instead. Both directions keep what you already paired with.

 * The desktop app opens on a welcome screen whenever it cannot reach an
   assistant — a fresh install, one whose stored connection has gone, or one
   running its own copy whose data you deleted — with both ways to get one in
   front of you rather than the half you happened to pick last time. And
   "Change where Turminder runs…" in the tray gets you back to it whenever you
   want, without deleting anything.

 * Transcribers and speech synthesisers are things you connect by asking, the
   same way you connect anything else: the assistant raises a form, checks the
   endpoint can actually hear and speak before writing anything down, and says
   what it cost. Any OpenAI-audio-compatible service works, local or hosted.

 * "Speak Norwegian" and "use a different voice" now work by asking. The
   assistant opens one form with the languages it can listen for and the voices
   it can speak with — and you can hear each voice before choosing it. It finds
   the voice list wherever your synthesiser keeps it, asks only about the model
   you have configured rather than everything the box happens to serve, and
   when you have switched synthesisers it stops defaulting to a voice the new
   one has never heard of.

 * Notifications can be read aloud by the desktop app, and a handler chooses
   the one sentence worth hearing: "Invoice from Hafslund, two thousand three
   hundred kroner, due Friday" instead of the three-line body it wrote for the
   screen. One arriving while the assistant is mid-sentence waits its turn.

 * A model that thinks before answering can be told not to. Thinking is now a
   level like any other — off, low, high — pickable per conversation, and
   spoken conversations turn it off by default because a second of silence
   before the first word is a second too long.

 * The desktop app remembers which port it ran on and takes it again next
   launch, so a link to a chart or dashboard you opened in a browser tab still
   works tomorrow — and the window stops forgetting anything it remembered,
   since a new port meant a new origin and a fresh slate every time. If
   something else has taken the port it quietly picks another, as before.

 * Schedules now cope with a machine that is not always on. A reminder and a
   daily digest want opposite things when the laptop was shut, so each schedule
   says which it is: a missed reminder still arrives, late, and a missed digest
   is skipped rather than posted at teatime as though it were morning. Anything
   that does fire late says how late it is, so the assistant can open with
   "this is yesterday's" instead of pretending. Being away for a week produces
   one catch-up and one note saying how many occurrences went by — not seven
   runs, and not silence.

 * Fixed: whether a late schedule fired at all depended on how the service came
   to notice it. Restarting the machine marked yesterday's briefing missed;
   suspending and resuming fired the same briefing hours later as though
   nothing had happened. Both take the same route now.

 * Fixed: a daily schedule drifted by an hour when the clocks changed, and
   stayed there. "Every day at 08:00" became 08:00 for good on one side of a
   daylight-saving change and 09:00 for good on the other; it now keeps the
   time you asked for, on either side.

 * Tell the assistant what an endpoint charges and it can now write it down:
   "the Anthropic endpoint is $3 in and $15 out per million" brings up a small
   form with whatever is already configured filled in, you type the figures,
   and the cost estimates beside your conversations start working. Setting a
   price used to mean hand-editing `config/models.yaml`, so on most installs
   the cost ledger was simply empty. The form says the one thing that matters
   about a price change — it applies from now on, and past runs keep what they
   ran at — and offers a way back to no price at all, which is not the same as
   a price of zero: a local box says `local`, never `0.00`.

 * A new **Activity** panel shows what the assistant is working on. Anything
   that arrives — a page captured from the browser extension, a scheduled job,
   a webhook — appears there the moment it lands and moves through queued,
   running and done while you watch, without a refresh and from whatever
   conversation you happen to be reading. Something retrying says when it will
   try again; something that gave up stays on the list and says why, instead of
   disappearing into a silence you have to go looking for. An approval waiting
   on you shows there too, so one raised while you were elsewhere is not
   something you have to remember. It is a live window on what is outstanding,
   not a log browser, and the contents of what arrived are never shown there —
   only what the assistant itself wrote about it. Its tab carries a count of
   what is still outstanding, so the question it exists to answer — is the
   thing I asked for happening? — needs no click at all: the number turns
   amber for something retrying or waiting on you, red for something that
   gave up.

 * Files, views and activity are one panel now, on the right of the window,
   with three tabs in a strip along the top instead of four separate toggles
   at the bottom of the conversation list. They were never on screen together
   — the layout only ever had room for one — so what has changed is that the
   controls say so, and that reaching your files on a phone is one tap rather
   than opening the conversation list to find the button first. The tabs stay
   lit and usable while a panel is covering the conversation, so moving
   between them is a single tap; pressing the tab you are already on puts the
   panel away. That strip is the window's toolbar now, and it leads with who
   you are talking to: your assistant's name, then Turminder's, then what it
   is doing and which model it is on — and, at the right, devices and sign
   out, reachable whether or not the conversation list is open. The
   conversation list is just the list now; everything that used to sit above
   and below it is up there.

 * The conversation list and the side panel can both be dragged wider or
   narrower, by the mouse or with the arrow keys, and each remembers its width.
   Neither can be dragged far enough to squeeze the conversation out: a column
   only grows into room the transcript can spare, so the handle stops where the
   text would start becoming unreadable. Make a window narrower than what you
   chose will fit and the columns give ground for as long as they have to,
   then take it back when the window grows again — what you dragged to is not
   forgotten because the window changed shape.

 * The file panel is a folder tree rather than a flat list of full paths.
   Folders start open, remember the ones you close, count what is inside them
   while closed, and open themselves when you open a file that lives in them.

 * Fixed: on a phone, the box you type in could end up behind the on-screen
   keyboard. The page was still being laid out against the full height of the
   screen, keyboard or no keyboard, so the composer — the last thing in the
   column — went under it, sporadically enough to depend on the browser, the
   orientation, and whether the address bar had already slid away. Both halves
   are handled now: Chrome and the Android browsers are told to shrink the page
   for the keyboard, and Safari, which has no such setting, gets the visible
   height measured and handed to the layout. The home-indicator allowance no
   longer stacks on top of a keyboard that already covers the indicator, the
   transcript still scrolls to its real bottom once the keyboard is up, and a
   grown composer stays inside the space that is actually left.

 * Fixed: the token counter over-reported, and the longer you talked the worse
   it got. The figure beside the context bar is meant to be the largest single
   prompt of the run — what has to fit at once — and it was adding the run's
   own output on top, which every turn after the first already contains. On a
   long tool-using run that nearly doubled it: 19,325 tokens shown as 38,105
   against a 98k window, which is the difference between a quarter full and
   half full. The live figure was wrong the other way on a thinking model,
   because it counted only the words you can see stream and reasoning is about
   two thirds of what gets billed — so it crept up and then jumped. Both now
   count what they say they count. Work done, and what it cost, are unchanged
   and still beside it.

 * Fixed: tokens spent by a run that crashed or was interrupted by a restart
   vanished from the conversation total. They were always in the trace; the run
   itself recorded them only when it finished cleanly.

 * Approval requests are written in words now. Being asked to allow something
   used to mean reading the call as it goes over the wire —
   `{"path":"notes/2026/august.md","recursive":false}` — at the one moment the
   assistant most needs to be understood. It is a sentence instead: who is
   asking and what they want to do, then a line per detail. Files appear as the
   path you recognise, lists as a count and a few, an attached document as its
   size rather than its text, and a stored credential as "a stored secret" —
   never the reference, and never on the notification either. The dialog also
   says when it expires, because an unanswered approval quietly becomes a No
   after an hour and nothing on screen used to admit that. Every word of it is
   written by the service, never by the assistant asking for permission.

 * Fixed: on a long think, the start of the assistant's reasoning vanished
   while you were reading it. The block kept only the last few thousand
   characters, so a model reasoning for a minute wrote its own opening out of
   existence. The whole chain is kept now, in a box that scrolls rather than
   growing until it owns the transcript — scroll back through it mid-run and
   the transcript stays where you left it. Reasoning is still never saved:
   reload and it is gone, as before.

 * A thinking block now says what the think cost, beside how long it took:
   `~1.1k out · 2.8s`. Reasoning is billed like any other output and on a
   thinking model it is most of it, but it never appears in the transcript —
   so by the time the number reaches the strip under the composer it has been
   folded into the turn's total and there is no longer anything to attach it
   to. On the block it belongs to the thinking that produced it. It is an
   estimate and says so: counts arrive per turn, never per block. A stretch of
   work that only called tools shows nothing there.

 * Fixed: the browser extension could never pair on Firefox. **Connect this
   browser** said it could not reach the gateway and asked whether the service
   was running, about a service that was running and answering — it had asked
   Firefox for access to a URL with the port left on, which Firefox accepts and
   then matches nothing with, so the pairing calls were blocked inside the
   browser before they were ever sent. Chromium was unaffected.

 * Setup lets you choose which of an endpoint's models to use, instead of
   silently taking whichever one it listed first. Picking one re-probes it,
   so the capabilities shown are the ones that get written down.

 * Fixed: tool calling did not work against Anthropic or OpenAI at all, and
   setup reported those models as having no tool support. Both reject a dot in
   a tool name, and every Turminder tool is named `namespace.verb`; names now
   cross the wire in a form they accept and arrive back unchanged. Handlers,
   grants and anything you have already written are untouched.

 * Setup checks whether your endpoint can make embeddings and ticks the box
   for you when it can, saying how wide the vectors are (and what the endpoint
   said when it cannot) — instead of guessing
   from a built-in list of which providers have an embeddings API. The key
   now travels with that setting, so semantic search works on a hosted
   provider rather than failing on the first index build.

 * Fixed: setting up an Anthropic endpoint failed with a 401 on a valid API
   key — the model list is served from Anthropic's own API, which wants the
   key in a different header than the chat endpoint does.

 * PDF export does no background networking, so it reaches your own service
   and nowhere else. If a print does overrun its minute it now says it timed
   out, instead of reporting that chromium finished and wrote nothing —
   chromium exits cleanly when asked to stop, which made a hung export look
   like a completed one. Some chromium builds hang on any headless command,
   whatever they are asked to print; where that happens the export times out
   and tells you so, and a chromium from your distribution is the fix.

 * Prebuilt downloads: every release carries the desktop app for Linux (x64
   and arm64), macOS (Apple silicon) and Windows, the packaged browser
   extensions, and a `SHA256SUMS` to check them against — plus a rolling
   `nightly` prerelease built from `main`. Linux x64 comes as both a `.deb`
   and a portable AppImage that needs nothing installed. The macOS build is
   ad-hoc signed rather than notarized, until there is a Developer ID to sign
   it with — so macOS refuses it on first open and calls it damaged, which it
   is not. The notes beside the download say so, and give the two ways
   through: **System Settings → Privacy & Security → Open Anyway**, or
   `xattr -dr com.apple.quarantine`. Control-clicking the app and choosing
   *Open* is not one of them; Apple removed that in macOS Sequoia. The Firefox
   extension ships as a Mozilla-signed `.xpi` you can install and keep, rather
   than a zip Firefox will only hold onto until you restart it — signed for
   self-distribution, so it is not listed on addons.mozilla.org and updates
   come from here.

 * The assistant no longer files away facts about its own setup — which
   endpoints it has, what they can do, which integrations are switched on. It
   looks those up when it needs them, so a note written weeks ago cannot
   outlive the thing it described. This is why an assistant that had just been
   given a vision model could still insist it had none, about a picture you
   had handed it.

 * Fixed: the built service (`npm run build` + `npm start`, and the systemd
   unit over it) served no interface — the chat page, setup page, styles and
   vendored browser libraries all came back as errors, while `npm run dev`
   was fine.

 * Which model handles what is now a table you can read and edit —
   `config/models.yaml` gets a `routes:` block naming a class or an exact
   endpoint per purpose (chat, handlers, titling, memory, and so on),
   `turminder models` prints it against your actual config, and every model
   call in the trace records which endpoint served it and why.

 * A new **Requests** panel, beside Activity, shows every call to a model as
   it happens: when, for what, which endpoint, tokens in and out, the
   estimated cost, and how long it took. Nothing more — no prompt text, no
   arguments.

 * When the assistant writes a new behavior and more than one model is
   configured, you choose which one runs it — a small form appears, the same
   way setting a price does. The assistant cannot make that choice for
   itself.

 * Fixed: the assistant could talk itself into a loop after saving a memory —
   re-saving the same note over and over, and twice writing the system's own
   "content stored" placeholder into the memory instead of the note. It now
   gets a plain "updated, N characters" answer when a write lands, a
   placeholder can no longer be saved as if it were content, a third rewrite
   of the same memory or file in one go is called out for what it is, and a
   write that was refused no longer pretends its content was stored.

 * Memory names are titles now — at most 80 characters — so the list of what
   the assistant remembers reads as headings rather than as the memories
   themselves.

 # 1.0.0

 Initial public release.
