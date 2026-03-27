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

## Development

```bash
task test     # Run integration tests
task lint     # shellcheck + shfmt
task fmt      # Auto-format shell scripts
```
