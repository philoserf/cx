# cx

A macOS command-line tool for managing Apple Contacts. Built with JXA (JavaScript for Automation) for full access to all contact properties, including notes.

## Install

```bash
task install
```

This symlinks `cx` to `~/.local/bin/cx`.

## Usage

```text
cx list [--group <name>]              List contacts
cx search <query>                     Search contacts
cx get <id>                           Show contact details
cx create --first <n> --last <n> ...  Create contact
cx update <id> [--field value ...]    Update contact
cx delete <id> [--force]              Delete contact
cx groups list|members|add|remove|create|delete
```

Use short IDs (first 8 characters) or full UUIDs.

### Multi-value fields

Repeat flags for multiple values. Use `label:value` syntax:

```bash
cx create --first Jane --last Doe --email work:jane@co.com --email home:jane@home.com
```

For complex input (addresses, social profiles), pipe JSON via stdin:

```bash
echo '{"firstName":"Jane","lastName":"Doe","emails":[{"label":"work","value":"jane@co.com"}]}' | cx create --json
```

## Why JXA?

Apple's `CNContactStore` requires the `com.apple.developer.contacts.notes` entitlement to access contact notes. This entitlement requires Apple approval and an app bundle. JXA via `osascript` has full access to all contact properties with no entitlements or signing required.

## Performance

Baseline benchmarks with ~479 contacts (2026-03-26, Apple M4):

| Command        | Time  | Notes                                  |
| -------------- | ----- | -------------------------------------- |
| list           | ~70s  | Fetches all contacts + properties      |
| search (hit)   | 1.1s  | `whose()` filters server-side          |
| search (miss)  | 0.6s  |                                        |
| create         | 0.6s  |                                        |
| get            | 10.5s | Short ID resolution scans all contacts |
| update         | 10.4s | Same resolve bottleneck                |
| delete         | 10.3s | Same                                   |
| groups create  | 0.15s |                                        |
| groups list    | 0.3s  |                                        |
| groups add     | 10.6s | Resolve bottleneck                     |
| groups members | 0.2s  |                                        |
| groups remove  | 10.2s | Resolve bottleneck                     |

The main bottlenecks are `list` (per-contact property access) and short ID resolution (`app.people()` fetches all contacts). Run `task bench` to regenerate.

## Development

```bash
task test     # Run integration tests
task lint     # shellcheck + shfmt for shell, biome for JS
task fmt      # Auto-format shell scripts and JS
```
