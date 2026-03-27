# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`cx` is a macOS CLI for managing Apple Contacts via JXA (JavaScript for Automation). It exists because CNContactStore cannot access contact notes without Apple-approved entitlements. JXA has full access with no signing or entitlement requirements.

## Architecture

- `cx` — bash wrapper that runs `osascript -l JavaScript cx.js -- "$@"`
- `cx.js` — all JXA logic in a single file (~735 lines): arg parsing, Contacts.app interface, text formatting, command dispatch
- `tests/test.sh` — integration tests exercising full CRUD lifecycle against real Contacts.app
- `Taskfile.yml` — install, test, lint, fmt tasks

JXA has no module system. Everything is in one file by design.

## Commands

```bash
task test       # Run integration tests (creates/deletes test contacts)
task lint       # shellcheck + shfmt -d on shell scripts
task fmt        # shfmt -w on shell scripts
task install    # Symlink cx to ~/.local/bin
task uninstall  # Remove symlink
```

```bash
cx list [--group <name>]
cx search <query>
cx get <id>
cx create --first <name> --last <name> [--email label:addr] [--phone label:num] [--note text] ...
cx create --json                        # reads JSON from stdin
cx update <id> [--note text] ...
cx update <id> --json                   # reads JSON from stdin
cx delete <id> [--force]
cx groups list|members|add|remove|create|delete
```

All output is text. Errors go to stderr. Exit codes: 0 success, 1 error, 2 permission denied, 3 not found, 4 ambiguous ID, 5 confirmation required.

## Key Gotchas

- **`namePrefix` in JXA throws `-1700`** on some contacts. The `formatCard` function wraps it in a try/catch.
- **`app.add(person, {to: group})`** is required for group membership. `group.people.push()` throws error -1701.
- **Always call `app.save()`** after mutations or changes won't persist.
- **Phone/email labels** from Contacts.app use raw Apple format like `_$!<Mobile>!$_`. The display is functional but not pretty.
- **Short IDs** are first 8 chars of the UUID (before the `:ABPerson` suffix).
