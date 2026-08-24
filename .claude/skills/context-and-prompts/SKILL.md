---
name: context-and-prompts
description: Invariants for the model/prompt/context layers. Read before touching src/model/, src/prompts/, src/chat/executor.ts, the dispatchers, or anything that builds messages, streams deltas, assembles system prompts, or persists turns. The bugs here don't fail — they silently cost tokens, bust the llama.cpp cache, or leak reasoning into history.
---

# Context & prompts — invariants (spec §20, §21, App. H)

This layer's failure mode is unique: a wrong change **works**. Chat still
answers. What breaks is invisible — the prompt-cache prefix, the token
floor, the display/context separation — and it's discovered weeks later in
billing traces. So the rule is: **if a guard test fails after your change,
the change is wrong, not the test.** The guards:
`test/context-discipline.test.ts`, `test/reasoning.test.ts`, and the
prefix-stability assertions. Never loosen them to make a change pass.

## The three-transcript model (§20)

Display (`turns.text`, everything the user watched), trace (everything,
excerpted, from ORIGINALS), model context (the minimum that preserves
coherence — assembled per call, never stored). Every rule below separates
the third from the first two. If your change makes one artifact serve two
of these roles, it's wrong.

## Never break these

1. **Reasoning is never context** (§20.1). `<think>` content: streams to UI
   as activity only; stripped from `text`; never in `messages`,
   `assistantText`, or `turns`; not stored anywhere (metrics only). The
   streaming tag filter holds back only tag-prefix suffixes — do not
   "simplify" it into buffering whole deltas or regexing the final string.
2. **History re-reads `context_text`, never `text`** (§20.2).
   `context_text` = last non-empty utterance of the run;
   `(used tools: …)` composed at read time; fallback to `text` only for
   old rows. The UI renders `text`. Don't swap these.
3. **Prefix stability** (§20.5, §21.2.7): system prompt =
   conversation-stable material ONLY. Retrieved memories are the ephemeral
   `<memory-recall>` user-role message before the latest user message —
   never in the system prompt, never persisted. Toolset + catalog are
   sorted and byte-deterministic for a given open set. Anything per-turn
   goes at the TAIL of messages. If you add per-turn content to the system
   prompt, you have re-broken the cache for the whole conversation.
4. **Within-run messages only append** — except the two sanctioned in-place
   edits: §20.4 elision (>2000 chars, ≥2 turns old, monotonic — never
   un-elide) and nothing else. Tool calls, assistant text, user messages
   are never mutated.
5. **The transcript result cap lives in the hub** (`budgeted()`, §20.3),
   not in tools, not in the loop. Trace `result_excerpt` and activity
   summaries derive from the ORIGINAL output, only the transcript gets the
   capped `{_truncated, …}` shape.
6. **Paging is presentation, never permission** (§21.2). `PagedDispatcher`
   filters *visibility*; `GrantedDispatcher` owns *grants*, untouched and
   unbypassable. Never fold them together. Granted-but-closed calls
   implicitly open and execute; ungranted calls refuse exactly as before —
   the refusal path must not change by one byte.
7. **The open-namespace set is monotonic and persisted** on the
   conversation row, loaded as `core ∪ persisted`. New conversation = core
   only. Don't cache it in memory across runs without the write-through.
8. **Budgets are policy in the loop** (agent-loop.ts): `promptTokens` is
   the MAX single-turn prompt (not the sum — summing makes a 4-turn run
   look like 4× the work); budget check is `promptTokens + tokensOut`.
   Budget exhaustion is a stop reason the caller handles, never an
   exception.
9. **Every LLM call goes through `ModelGateway.turn()`** — priority,
   queue-wait, and the `llm_call` trace row cannot be bypassed. New agent
   kinds get a base prompt file in `src/prompts/` (H.5), assembled
   static-first (H.1); they never concatenate ad-hoc system strings.
10. **Usage numbers mean what App. C.1 says**: `tokens_in` per call is that
    call's full prompt; `prompt_evaluated` is llama.cpp's uncached count,
    best-effort, absence is not an error. The UI headline is peak context
    vs window — never the cumulative billed sum (§21.1).

## Fencing (H.2)

External content (`<untrusted source=…>`) vs user-authored (chat text,
`<file path=…>`). The wrapper + escaping is the prompt assembler's job —
callers never hand-fence. If you add a new content source, decide its trust
level per §14 and add it to H.2, in the same commit.

## Exemplars

`src/model/agent-loop.ts` (the loop + its header comments),
`src/chat/executor.ts` (context assembly), `src/prompts/index.ts`
(assembly order). The comments in these files are load-bearing
documentation — keep them true when you change behavior.
