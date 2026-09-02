# A theory of `cx`

## What this system is for

`cx` is a CLI shaped around a single, peculiar fact about macOS: the contact data the user actually owns lives in a database (`Contacts.app`) whose programmatic doors are guarded unevenly. The native door — `CNContactStore` — has a lock on the most personal field, the **note**, that only Apple can unlock by granting an entitlement to a signed app bundle. The side door — AppleScript/JXA via `osascript` — has no such lock and no signing requirement. `cx` is, in essence, the user's refusal to accept that asymmetry: a personal scripting tool that treats the side door as the real interface and reconstructs CRUD-over-contacts on top of it.

Domain entities are exactly what Contacts models: **Person**, **Group**, and the typed multi-value collections that hang off a person (emails, phones, urls, addresses, related names, IMs, custom dates, social profiles). The vocabulary in `cx.js` maps onto these one-to-one — there is no domain layer, no abstraction over Contacts.app, no data model of `cx`'s own. The Contacts scripting object model _is_ the domain model, and the script is a thin grammar that lets a shell user speak it.

## Organizing ideas

Three ideas hold the code together.

**One file, no modules, by design.** JXA has no `require`/`import`. `CLAUDE.md` calls this out explicitly. The ~1230-line `cx.js` is therefore organized by section comments (`--- Commands ---`, `--- Selftest ---`) rather than by file boundaries. A maintainer who tries to "tidy this up" by splitting files is fighting the runtime, not the code. The one concession to testability is `cx selftest`, which ships test code in the production file because there is nowhere else to put it.

**The script is a translation layer between two grammars.** On one side: `argv`-style flags (`--first`, `--email work:a@b.com`, `--json`) that a shell user can compose. On the other: JXA's quirky property-assignment, `app.Email({label,value})` constructor, `app.add(person, {to: group})` verb, and `whose({_or:[...]})` query DSL. Almost every function in the file is doing one of three things: reading flags into a normalized `flags` object, walking that object to call JXA, or walking a JXA object to format text. The `SCALARS` and `MULTI` catalogues are what make this tractable: they are the single definition of every field, and the parser, the writers, the renderers and the usage text are all loops over them. Adding a field is one row, not four edits in four places.

**Identifiers are dual.** A Contacts UUID looks like `ABCD…:ABPerson`, which is unusable on a command line. `shortId` (first 8 chars) is the user-facing form. `resolveId` accepts either, and `cmdGet`/`cmdUpdate`/`cmdDelete`/`groupsAdd`/`groupsRemove` _all_ go through it. This is the system's most important invariant: **any command that takes a contact ID must resolve it via `resolveId`, never `app.people.byId` directly**, because short-ID disambiguation (exit code 4) is part of the contract. It is now a single `whose({id: {_beginsWith}})` query rather than a full scan, so honoring the invariant costs nothing — it was the reason `get`/`update`/`delete` all clocked ~10s.

## Invariants worth naming

- **Every mutation ends in `app.save()`.** Forgetting it leaves the change in scripting-bridge limbo. `CLAUDE.md` flags this; the code is consistent.
- **`namePrefix` throws `-1700` on some contacts.** Its row in `SCALARS` carries `guarded: true` and `readCard` wraps that one read. It is not removable.

- **Reading and rendering are separate.** `read*` touches Contacts and returns plain records; `format*` takes records and never touches a JXA object. That boundary is why `--format json` is a serializer rather than a second renderer, and why `cx selftest` can check the card layout with no Contacts.app at all.

- **Plural property access is the design, not an optimization.** `app.people.id()` is one Apple Event for the whole address book; a loop calling `person.id()` is one per contact. It works on `app.people` and on a group's people but *not* on a `whose()` specifier, which measured worse than the loop — so `cmdSearch` keeps per-contact reads on purpose.
- **Group membership goes through `app.add(person, {to: group})`,** not `group.people.push(person)` — the latter throws `-1701`. This is invisible from the code unless you know to look.
- **Exit codes are part of the API.** 0/1/2/3/4/5 mean specific things (success / generic error / permission denied / not found / ambiguous / confirmation required). The integration test asserts on 3, 1, 5; changing a code is a breaking change.
- **`--force` for destructive ops is a two-step protocol, not a confirmation prompt.** First call prints what would be deleted and exits 5; second call with `--force` performs it. This exists because JXA can't read a tty.

## Seams

The system has exactly three external seams and they are all on the same side: shell ↔ `cx` (bash wrapper) ↔ `osascript` ↔ `Contacts.app`. The bash wrapper exists for one reason — to follow symlinks so `task install`'s `~/.local/bin/cx` can find `cx.js` next to its real path. The `--` separator in `osascript -l JavaScript cx.js -- "$@"` and the matching `pastSeparator` loop in `getArgs` exist because `osascript` swallows args before `--`.

Internally there is one seam doing real work: the **flag-shape boundary** between flag-style input and `--json` stdin input. JSON input uses Contacts' native field names (`firstName`, `organization`, `jobTitle`); flag input uses short forms (`first`, `org`, `title`). `readInput` is that seam. It returns `{source, fields, positionals}`, both modes normalize into flag-space `fields`, and the rename table is derived from `SCALARS` rather than written out.

This used to be a rename block duplicated verbatim in `cmdCreate` and `cmdUpdate`, with the mode smuggled into the data as `flags.json`. That arrangement silently dropped `--group` in JSON mode and made the multi-value branching unreadable. The create/update divergence it was hiding is real and remains, but it is now stated: **flag input appends** unless `--replace <field>` empties a collection first, and **JSON input replaces** any collection its payload names.

## What change is easy, what is hard

**Easy:** adding a new scalar field (extend `applyScalarFields` and `formatCard`); adding a new repeatable label:value field (add to `repeatable` in `parseFlags`, add a branch in `addMultiValueFields`, add to `formatCard`'s `multiFields`); adding a new `groups` subcommand.

**Hard:** anything that wants to escape the one-file constraint, anything that wants interactive confirmation (no tty), anything that wants unit tests of code that touches Contacts. Replacing JXA with `CNContactStore` would erase the whole reason this tool exists.

An earlier version of this document called two of these structural and was wrong about both, which is worth recording. It said the short-ID scan could only be fixed by caching, "which means a state file, which is a different program" — in fact one `whose({id: {_beginsWith}})` query replaced it, no state involved, and the same plural-access trick took `list` from 47s to 0.8s. It also said structured output "means touching every formatter" — separating `readCard` from `formatCard` first made `--format json` a single branch at the point of output. Both claims were inferred from the code rather than measured. Measure first.

A maintainer who didn't understand the theory would most plausibly cause damage by: bypassing `resolveId` for "performance"; removing the `namePrefix` try/catch as dead code; replacing the two-step `--force` flow with a `read -p` prompt; or "fixing" the duplicated JSON-rename blocks into a shared helper without noticing the multi-value asymmetry.

## Uncertainties

I'm inferring intent from code, not from the authors. Specific guesses I'd flag:

- The `parseLabelValue` function specifically excludes `http`, `https`, `tel`, `mailto` from being parsed as `label:value`. This is clearly defensive against a URL being passed as `--url https://…` and getting `https` treated as a label. I'm assuming this list is exhaustive of the schemes the author cared about; a `ssh://` or `mailto:` URL with a label would behave surprisingly. May be drift, may be deliberate.
- Exit code 2 is claimed but has never been observed. `getApp` now probes with a real access and classifies `-1743`, which is the documented Apple Event code for a refused automation request, but nobody has revoked permission and watched it fire.
- The default labels in `MULTI` (`home` for email, phone and url, `friend` for related names, `anniversary` for custom dates) are inherited from the original implementation. Whether they match what the author actually wants is untested — nothing ever asserts on a default label.

Two uncertainties from the first draft have since been settled rather than answered: JSON updates now replace named collections, and `padRight`'s silent truncation was a bug, not a tolerance — column widths follow the data now.

The strongest sign that the theory is coherent and not just post-hoc storytelling: the gotchas memorialized in `CLAUDE.md` (`namePrefix`, `app.add` vs `push`, `app.save()`, label format, short-ID = first 8) are exactly the load-bearing invariants the code enforces. Author and code agree on what the dangerous edges are.
