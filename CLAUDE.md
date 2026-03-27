# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`cx` is a macOS CLI for managing Apple Contacts, built with JXA (JavaScript for Automation) via `osascript -l JavaScript`. It exists because CNContactStore cannot access contact notes without Apple-approved entitlements. AppleScript/JXA has full access with no signing or entitlement requirements.

The spec is in `cx-spec.md`.

## Architecture

- **Entry point:** `cx` — a shell script that calls `osascript -l JavaScript` with JXA source
- **JXA core:** `lib/contacts.js` — Contacts.app scripting interface
- **Formatting:** `lib/format.js` — text output (tables, cards)
- **Arg parsing:** `lib/args.js` — CLI argument handling
- **Tests:** `tests/`

JXA has no `require()` or `import`. The multi-file structure may need concatenation at build time, or everything may collapse into a single file. This is an open design question (see spec).

## Commands

```bash
cx list [--group <name>] [--format text]
cx search <query> [--format text]
cx get <id> [--format text]
cx create --first <name> --last <name> [--email <addr>] [--phone <num>] ...
cx update <id> [--first <name>] [--last <name>] ...
cx delete <id> [--force]
cx groups list|members|add|remove|create|delete ...
```

All commands output JSON to stdout by default. Errors go to stderr as JSON. `--format text` for human-readable output.

## Key Design Decisions

- **JSON-first output** — designed as a tool for Claude Code; human-readable is secondary
- **Short IDs** — first 8 characters of contact UUIDs; errors on ambiguous matches
- **Exit codes** — 0 success, 1 general error, 2 permission denied, 3 not found, 4 ambiguous ID, 5 confirmation required
- **No binary data** — contact images are out of scope
- **Notes access is the core capability** — the entire reason v2 exists

## Testing

Integration tests must cover create, read, update, and delete of a test contact with cleanup. Notes read/write is the critical path to test.
