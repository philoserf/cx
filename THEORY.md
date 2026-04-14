# A theory of `cx`

## What this system is for

`cx` is a CLI shaped around a single, peculiar fact about macOS: the contact data the user actually owns lives in a database (`Contacts.app`) whose programmatic doors are guarded unevenly. The native door — `CNContactStore` — has a lock on the most personal field, the **note**, that only Apple can unlock by granting an entitlement to a signed app bundle. The side door — AppleScript/JXA via `osascript` — has no such lock and no signing requirement. `cx` is, in essence, the user's refusal to accept that asymmetry: a personal scripting tool that treats the side door as the real interface and reconstructs CRUD-over-contacts on top of it.

Domain entities are exactly what Contacts models: **Person**, **Group**, and the typed multi-value collections that hang off a person (emails, phones, urls, addresses, related names, IMs, custom dates, social profiles). The vocabulary in `cx.js` maps onto these one-to-one — there is no domain layer, no abstraction over Contacts.app, no data model of `cx`'s own. The Contacts scripting object model _is_ the domain model, and the script is a thin grammar that lets a shell user speak it.

## Organizing ideas

Three ideas hold the code together.

**One file, no modules, by design.** JXA has no `require`/`import`. `CLAUDE.md` calls this out explicitly. The 723-line `cx.js` is therefore organized by section comments (`--- Commands ---`, `--- Multi-value field helpers ---`) rather than by file boundaries. A maintainer who tries to "tidy this up" by splitting files is fighting the runtime, not the code.

**The script is a translation layer between two grammars.** On one side: `argv`-style flags (`--first`, `--email work:a@b.com`, `--json`) that a shell user can compose. On the other: JXA's quirky property-assignment, `app.Email({label,value})` constructor, `app.add(person, {to: group})` verb, and `whose({_or:[...]})` query DSL. Almost every function in the file is doing one of three things: reading flags into a normalized `flags` object, walking that object to call JXA, or walking a JXA object to format text. `applyScalarFields` and `addMultiValueFields` are the load-bearing translators; they exist so that `create` and `update` can share field semantics without sharing control flow.

**Identifiers are dual.** A Contacts UUID looks like `ABCD…:ABPerson`, which is unusable on a command line. `shortId` (first 8 chars) is the user-facing form. `resolveId` accepts either, and `cmdGet`/`cmdUpdate`/`cmdDelete`/`groupsAdd`/`groupsRemove` _all_ go through it. This is the system's most important invariant: **any command that takes a contact ID must resolve it via `resolveId`, never `app.people.byId` directly**, because short-ID disambiguation (exit code 4) is part of the contract. The README's performance table makes it obvious why this matters and why it hurts — short-ID resolution is a full `app.people()` scan, which is the reason `get`/`update`/`delete` all clock ~10s.

## Invariants worth naming

- **Every mutation ends in `app.save()`.** Forgetting it leaves the change in scripting-bridge limbo. `CLAUDE.md` flags this; the code is consistent.
- **Every Contacts access is wrapped against `namePrefix` throwing `-1700`.** The `try/catch` IIFE inside `formatCard` looks ugly and is. It is not removable.
- **Group membership goes through `app.add(person, {to: group})`,** not `group.people.push(person)` — the latter throws `-1701`. This is invisible from the code unless you know to look.
- **Exit codes are part of the API.** 0/1/2/3/4/5 mean specific things (success / generic error / permission denied / not found / ambiguous / confirmation required). The integration test asserts on 3, 1, 5; changing a code is a breaking change.
- **`--force` for destructive ops is a two-step protocol, not a confirmation prompt.** First call prints what would be deleted and exits 5; second call with `--force` performs it. This exists because JXA can't read a tty.

## Seams

The system has exactly three external seams and they are all on the same side: shell ↔ `cx` (bash wrapper) ↔ `osascript` ↔ `Contacts.app`. The bash wrapper exists for one reason — to follow symlinks so `task install`'s `~/.local/bin/cx` can find `cx.js` next to its real path. The `--` separator in `osascript -l JavaScript cx.js -- "$@"` and the matching `pastSeparator` loop in `getArgs` exist because `osascript` swallows args before `--`.

Internally there is one seam that is doing real work: the **flag-shape boundary** between flag-style input and `--json` stdin input. JSON input uses Contacts' native field names (`firstName`, `organization`, `jobTitle`); flag input uses short forms (`first`, `org`, `title`). The JSON branches in `cmdCreate` and `cmdUpdate` rename keys back to short form before falling through to `applyScalarFields`. This rename block is duplicated verbatim across the two commands. That duplication is a real seam, not an accident — it's what lets `--json` and flag mode share the downstream code. It would be the natural target of a refactor and probably _shouldn't_ be refactored without care, because the two commands diverge on multi-value handling (`cmdUpdate` skips `addMultiValueFields` in JSON mode; `cmdCreate` has its own `flags.emails`/`flags.phones` branch). The asymmetry is real and load-bearing: `update` cannot append-vs-replace cleanly via JSON, so it punts.

## What change is easy, what is hard

**Easy:** adding a new scalar field (extend `applyScalarFields` and `formatCard`); adding a new repeatable label:value field (add to `repeatable` in `parseFlags`, add a branch in `addMultiValueFields`, add to `formatCard`'s `multiFields`); adding a new `groups` subcommand.

**Hard:** anything that wants to escape the one-file constraint, anything that wants to be fast on `get`/`update`/`delete` (the short-ID scan is structural — fixing it means caching, which means a state file, which is a different program), anything that wants interactive confirmation (no tty), anything structured-output (every command writes text via `writeStdout`; there's no `--format json` and adding one means touching every formatter). Replacing JXA with `CNContactStore` would erase the whole reason this tool exists.

A maintainer who didn't understand the theory would most plausibly cause damage by: bypassing `resolveId` for "performance"; removing the `namePrefix` try/catch as dead code; replacing the two-step `--force` flow with a `read -p` prompt; or "fixing" the duplicated JSON-rename blocks into a shared helper without noticing the multi-value asymmetry.

## Uncertainties

I'm inferring intent from code, not from the authors. Specific guesses I'd flag:

- The `parseLabelValue` function specifically excludes `http`, `https`, `tel`, `mailto` from being parsed as `label:value`. This is clearly defensive against a URL being passed as `--url https://…` and getting `https` treated as a label. I'm assuming this list is exhaustive of the schemes the author cared about; a `ssh://` or `mailto:` URL with a label would behave surprisingly. May be drift, may be deliberate.
- `cmdUpdate` in `--json` mode skips `addMultiValueFields` entirely, meaning JSON updates _cannot_ add emails/phones the way flag updates can. This looks like an unfinished thought rather than a principled choice — `cmdCreate` handles `flags.emails`/`flags.phones` from JSON, `cmdUpdate` doesn't.
- The README's benchmark table is dated 2026-03-26 but the recent commits include workflow changes and a walkthrough doc; the perf characteristics may have shifted, though nothing in the recent diffs suggests it.
- `padRight` truncates with `substring(0, len-1) + " "` — silently lossy for long names/emails in `list` output. Whether this is "acceptable for a personal tool" or "a bug nobody hit yet" I can't tell without asking.

The strongest sign that the theory is coherent and not just post-hoc storytelling: the gotchas memorialized in `CLAUDE.md` (`namePrefix`, `app.add` vs `push`, `app.save()`, label format, short-ID = first 8) are exactly the load-bearing invariants the code enforces. Author and code agree on what the dangerous edges are.
