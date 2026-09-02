# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`cx` is a macOS CLI for managing Apple Contacts via JXA (JavaScript for Automation). It exists because CNContactStore cannot access contact notes without Apple-approved entitlements. JXA has full access with no signing or entitlement requirements.

## Architecture

- `cx` — bash wrapper that runs `osascript -l JavaScript cx.js -- "$@"`
- `cx.js` — all JXA logic in a single file (~1230 lines): field catalogues, arg parsing, Contacts.app reads, text and JSON rendering, command dispatch
- `tests/test.sh` — integration tests exercising full CRUD lifecycle against real Contacts.app
- `tests/bench.sh` — timing harness behind `task bench`; regenerates the README performance table
- `Taskfile.yml` — install, uninstall, test, bench, lint, fmt tasks

JXA has no module system. Everything is in one file by design.

### The two catalogues

`SCALARS` and `MULTI` near the top of `cx.js` are the single definition of every
contact field, in the order a card renders them. The parser, the writers, the
renderers and the usage text all read them. **Adding a field is one row** — do
not add a case to any consumer.

### The read/render boundary

`read*` functions (`readSummary`, `readSummaries`, `readCard`) touch Contacts and
return plain records. `format*` functions take records and return text, and must
never touch a JXA object. That line is what makes `--format json` a serialiser
rather than a second renderer, and what lets `cx selftest` exercise rendering
with no Contacts.app at all.

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
accepts `--format json`.

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
found, 4 ambiguous ID, 5 confirmation required.

Multi-value semantics differ by input mode and this is deliberate: **flag input
appends** unless `--replace <field>` empties the collection first; **JSON input
replaces** any collection its payload names.

## Key Gotchas

- **`namePrefix` in JXA throws `-1700`** on some contacts. Its row in `SCALARS` is marked `guarded` and `readCard` wraps the read in a try/catch.
- **`app.add(person, {to: group})`** is required for group membership. `group.people.push()` throws error -1701.
- **Every mutation ends in `saveOrFail(app)`** or the change is lost.
- **Plural access is the difference between 0.8s and 47s.** `app.people.id()` fetches every id in one Apple Event; a loop calling `person.id()` costs one event each. This works on `app.people` and on a group's people, but **not** on a `whose()` specifier — measured at 13.3s for 256 names, worse than the loop. That is why `cmdSearch` still uses the per-contact `readSummary`.
- **Read a deleted object and JXA throws `-1728`.** Capture what you need before `app.delete`.
- **Dates are date-only values stored at noon local time.** `new Date("1990-05-14")` parses as UTC midnight, which is the previous day west of Greenwich. Always go through `parseDateFlag` and `formatDate`.
- **Phone and email labels** come back wrapped as `_$!<Mobile>!$_`; `unwrapLabel` strips that.
- **Short IDs** are first 8 chars of the UUID (before the `:ABPerson` suffix). `resolveId` resolves either form with one `whose({id: {_beginsWith}})` query, which is case-insensitive.
