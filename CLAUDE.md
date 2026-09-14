# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`cx` is a macOS CLI for managing Apple Contacts via JXA (JavaScript for Automation). It exists because CNContactStore cannot access contact notes without Apple-approved entitlements. JXA has full access with no signing or entitlement requirements.

## Where to read what

This file is the short brief: the layout, the commands, and the gotchas that are
expensive to rediscover. It deliberately does not restate the design.

- **`THEORY.md`** — what you need to understand to change this without damaging it.
  The organizing ideas, the invariants, the seams, and what is easy versus hard.
  **Read it before changing the write path or the catalogues.**
- **`WALKTHROUGH.md`** — how a command runs, in order, with executable snippets.
  `uvx showboat verify WALKTHROUGH.md` re-runs every block.
- **`README.md`** — the user-facing interface and the performance table.

If something here and `THEORY.md` disagree, `THEORY.md` is the considered account
and this file is the summary that drifted.

## Architecture

- `cx` — bash wrapper that runs `osascript -l JavaScript cx.js -- "$@"`
- `cx.js` — all JXA logic in a single file: field catalogues, arg parsing, input normalisation, Contacts reads and writes, text and JSON rendering, command dispatch
- `tests/test.sh` — integration tests against real Contacts.app; cleans up by searching its `CxTest_<pid>_` prefix rather than by a list it built as it went
- `tests/bench.sh` — timing harness behind `task bench`; regenerates the README performance table
- `Taskfile.yml` — install, uninstall, test, bench, lint, fmt tasks

JXA has no module system. Everything is in one file by design, and section
banners are the only structuring device available. There are four, and the third
is load-bearing:

```
// --- Process I/O: stdin, stdout, stderr, argv, exit ---
// --- Pure helpers ---
// --- Contacts access ---
// --- Commands and dispatch ---
// --- Run ---
```

`Pure helpers` means plain data in, plain data out, touching no JXA object;
everything below `Contacts access` talks to Contacts.app. So position answers
"does this touch Contacts?" — keep it that way when adding a function.

### The two catalogues

`SCALARS` and `MULTI` are the single definition of every contact field, in the
order a card renders them. The parser, the flag allowlist, the writers, the
renderers and the usage text all read them. **Adding a field is one row** — do
not add a case to any consumer; if you want to, the row is missing a key.

Two keys are easy to get wrong:

- **`ctor` on `MULTI` is the writable test.** It is present on every row `cx` can
  construct and absent only on `instantMessages`. Writers filter on it. Do not
  invent a second key for this — the previous filter was a `json` key that only
  two rows carried, and four writable collections were silently dropped.
- **`json` is a `SCALARS` concept only**, naming a payload key where it differs
  from the Contacts property. Exactly one row needs it (`suffix` / `nameSuffix`).
  A collection's payload key is always its `coll`.

### The change record

Both input dialects — flags and `--json` stdin — normalise into one plain record
built by `buildChange`, keyed by Contacts property name:

```
{ scalars: {firstName, birthDate: <Date>}, note: {mode, text},
  collections: {emails: {mode, items}}, group, format }
```

`buildChange` is pure and touches nothing, which is why `cx selftest` can cover
the whole input mapping. **Every rejection belongs in it**, before `getApp()` —
see the invariant below. `applyScalars`, `applyNote` and `applyCollections`
consume the record and are the only writers.

### Input is closed

`parseArgs` takes a per-command allowlist derived from the catalogues. A flag the
command does not read is an error, as is an unknown payload key and an update
naming no field. Exit 0 from a write means something changed. (`selftest` is the
one exception: it is dispatched without `parseArgs` and ignores anything given.
Harmless — it writes nothing — but do not read it as the pattern.) Do not loosen this
to "accept and ignore" — the field this tool exists for has no undo, and a silent
no-op reported as success is the worst available outcome.

## Commands

```bash
task test       # selftest, then integration tests (creates/deletes test contacts)
task bench      # Benchmark commands (requires gdate from coreutils)
task lint       # shellcheck + shfmt on shell scripts, biome on cx.js
task fmt        # shfmt + biome --fix
task install    # Symlink cx to ~/.local/bin
task uninstall  # Remove symlink
```

`cx help` prints the full flag list, generated from the catalogues. Every command
that produces output accepts `--format json`.

```bash
cx list [--group <name>]
cx search <query>
cx get <id>
cx create (--first|--last|--org) <name> [--email label:addr] [--note text] [--group <name>] ...
cx create --json                        # reads JSON from stdin
cx update <id> [--note text] [--note-append text] [--replace email] ...
cx update <id> --json                   # reads JSON from stdin
cx delete <id> [--force]
cx groups list|members|add|remove|create|delete
cx selftest                             # pure-function checks, touches nothing
```

Errors go to stderr. Exit codes: 0 success, 1 error, 2 permission denied, 3 not
found, 4 ambiguous ID, 5 confirmation required. **The exit-code set is the API** —
changing which input produces which code is a breaking change.

Multi-value semantics differ by input mode and this is deliberate: **flag input
appends** unless `--replace <field>` empties the collection first; **JSON input
replaces** any collection its payload names. Where both name the same collection,
replace wins and both sets of values land in it. The two key spaces were merged;
these two semantics were not, and unifying them breaks one of two workflows.

## Key Gotchas

- **`namePrefix` in JXA throws `-1700`** on some contacts. Its row in `SCALARS` is marked `guarded` and `readCard` wraps the read in a try/catch.
- **`app.add(person, {to: group})`** is required for group membership. `group.people.push()` throws error -1701.
- **A mutation goes live in the running app as it is made; `save` persists it to disk.** Measured: push a person without saving and a _separate process_ finds it; quit Contacts.app and it is gone. So a failure between the push and `saveOrFail(app)` strands a real, findable, half-built contact for the life of the Contacts process. That is why **nothing that can fail may run after `app.people.push`** — validation lives in `buildChange`, and the three writers contain no `exitWithError` between them. Keep it that way.
- **Contacts validates nothing.** `--email "work:))))"` is accepted and stored. `cx` type-checks input and value-checks exactly one thing, dates. A write that succeeded was inspected by nobody else.
- **Plural access is the difference between 0.8s and 47s.** `app.people.id()` fetches every id in one Apple Event; a loop calling `person.id()` costs one event each. This works on `app.people` and on a group's people, but **not** on a `whose()` specifier — measured at 13.3s for 256 names, worse than the loop. That is why `cmdSearch` still uses the per-contact `readSummary`.
- **Read a deleted object and JXA throws `-1728`.** Capture what you need before `app.delete`.
- **Dates are date-only values stored at noon local time.** `new Date("1990-05-14")` parses as UTC midnight, which is the previous day west of Greenwich. Always go through `parseDateFlag` and `formatDate`.
- **Phone and email labels** come back wrapped as `_$!<Mobile>!$_`; `unwrapLabel` strips that.
- **Short IDs** are first 8 chars of the UUID (before the `:ABPerson` suffix). `resolveId` resolves either form with one `whose({id: {_beginsWith}})` query, which is case-insensitive. Automated callers should pass the full id: a short one can collide, and exit 4 is not something a script can retry out of.
