---
name: authoring-skills
description: How to write a skill — a document that teaches you when and how to use a set of tools. Use whenever you are about to write or change a file under skills/, including after connecting a new service.
---

# Writing a skill

A skill is one markdown file in `skills/<name>.md`, written with
`config.write`. It is how a pile of tool names becomes usable knowledge:
the description is always in your system prompt, and you fetch the body with
`skills.fetch` when it looks relevant.

**The frontmatter is not optional.** A file without it is ignored at load time,
so the skill you carefully wrote does nothing at all.

```markdown
---
name: firmafakta
description: Looking up Norwegian company data — ownership, board, financials, grants. Use when a Norwegian company is mentioned by name or orgnr.
---

# Firmafakta

## When to use
...

## Workflow
1. ...
```

## The two fields

- **`name`** must equal the filename without `.md`. Kebab-case, no spaces.
- **`description`** is the only part you see until you fetch the body, so
  it has to carry the trigger. Write it as *when to reach for this*, naming the
  concrete nouns — "a Norwegian company, an orgnr, shareholders" — not as a label
  like "Firmafakta tools". If the description does not mention the thing the user
  will actually say, the skill will never be fetched.

## The body

Whatever you would want to know later: when this applies, which tools in what
order, what the arguments mean, what the traps are. Name tools exactly as they
appear in your tool list. Prefer a numbered workflow over prose.

Say what *not* to do, too — a skill that records "never pay an invoice
automatically" is worth more than one that only lists endpoints.

## Rules

- One subject per skill. Two loosely related topics are two files.
- No secrets, ever: skills are committed to git.
- After connecting a service, write *your* summary of when to use its tools, not
  a paste of its documentation.
- `config.write` refuses a file whose frontmatter is missing or malformed
  and tells you what is wrong — read the error and fix it rather than writing the
  same thing again.

*(Shipped with Turminder. Edit it freely — it is only re-created when missing.)*
