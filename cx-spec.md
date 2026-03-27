---
date: 2026-03-26
lastmod: 2026-03-26
---

## Purpose

A macOS command-line tool for managing Apple Contacts. Optimized as a tool for Claude Code, with human-readable output as a secondary mode. Replaces the v1 Swift/CNContactStore implementation, which cannot access contact notes due to Apple's entitlement restrictions.

## Lessons from v1

- **CNContactStore blocks notes access.** The `com.apple.developer.contacts.notes` entitlement requires Apple approval and an app bundle structure. A CLI tool cannot use it.
- **AppleScript has full access.** No entitlement, no signing, no bundle. Reads and writes all contact properties including notes.
- **Swift adds no value here.** CNContactStore's only advantage over AppleScript is performance at scale, which doesn't matter for a contacts tool used interactively by an AI agent.
- **JSON-first output matters.** Claude Code parses structured output. Human-readable formatting is nice but secondary.

## Implementation Language

JXA (JavaScript for Automation) via `osascript -l JavaScript`. Rationale:

- Full Contacts.app scripting access, same as AppleScript
- JavaScript is more natural for JSON serialization than AppleScript
- Single file or small set of files—no build step, no dependencies, no package manager
- Runs anywhere macOS runs, no toolchain required

Alternative considered: shell wrapper around `osascript -e` AppleScript fragments. Rejected because string escaping and structured data handling in bash is fragile. JXA handles objects and JSON natively.

## Commands

All commands output JSON by default. Add `--format text` for human-readable output.

### List

List all contacts or contacts in a group.

```text
cx list [--group <name>] [--format text]
```

Output: array of contact summaries (id, name, email, phone, organization).

### Search

Search contacts by name, email, phone, or any field.

```text
cx search <query> [--format text]
```

Output: array of contact summaries matching the query.

### Get

Get full details for a contact by ID (short or full).

```text
cx get <id> [--format text]
```

Output: complete contact record including all properties and notes.

### Create

Create a new contact.

```text
cx create --first <name> --last <name> [--email <addr>] [--phone <num>] [--org <name>] [--title <title>] [--note <text>] [--group <name>] ...
```

Output: `{ "id": "…", "shortId": "…" }`

### Update

Update an existing contact. Only specified fields are changed.

```text
cx update <id> [--first <name>] [--last <name>] [--note <text>] ...
```

Output: `{ "status": "updated", "id": "…" }`

### Delete

Delete a contact.

```text
cx delete <id> [--force]
```

Without `--force`, output the contact summary and exit with a non-zero code to signal confirmation needed. With `--force`, delete and output `{ "status": "deleted" }`.

### Groups

List all groups, or manage group membership.

```text
cx groups list
cx groups members <name>
cx groups add <contact-id> <group-name>
cx groups remove <contact-id> <group-name>
cx groups create <name>
cx groups delete <name> [--force]
```

## Contact Properties

Full set, all readable and writable:

| Property          | JSON key           | Notes                                                   |
| ----------------- | ------------------ | ------------------------------------------------------- |
| First name        | `firstName`        |                                                         |
| Last name         | `lastName`         |                                                         |
| Middle name       | `middleName`       |                                                         |
| Name prefix       | `namePrefix`       |                                                         |
| Name suffix       | `nameSuffix`       |                                                         |
| Nickname          | `nickname`         |                                                         |
| Maiden name       | `maidenName`       |                                                         |
| Organization      | `organization`     |                                                         |
| Job title         | `jobTitle`         |                                                         |
| Department        | `department`       |                                                         |
| Note              | `note`             | **The reason v2 exists**                                |
| Birthday          | `birthday`         | ISO 8601 or `--MM-dd`                                   |
| Emails            | `emails`           | Array of `{ label, value }`                             |
| Phones            | `phones`           | Array of `{ label, value }`                             |
| Addresses         | `addresses`        | Array of `{ label, street, city, state, zip, country }` |
| URLs              | `urls`             | Array of `{ label, value }`                             |
| Social profiles   | `socialProfiles`   | Array of `{ service, username, url }`                   |
| Related names     | `relatedNames`     | Array of `{ label, value }`                             |
| Instant messaging | `instantMessaging` | Array of `{ service, username }`                        |
| Dates             | `dates`            | Array of `{ label, value }`                             |
| Groups            | `groups`           | Array of group names                                    |
| Image             | `hasImage`         | Boolean (read-only)                                     |

## ID Resolution

Contacts have long UUIDs. The tool supports short IDs (first 8 characters) for convenience. If a short ID matches multiple contacts, return an error with the ambiguous matches listed.

## Output Format

### JSON (default)

All commands return valid JSON to stdout. Errors return JSON to stderr:

```json
{ "error": "not_found", "message": "No contact matching ID abc12345" }
```

### Text (`--format text`)

Human-readable output. List/search use a table. Get uses a card layout. Mutations print a one-line confirmation.

## Exit Codes

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | Success                                         |
| 1    | General error                                   |
| 2    | Permission denied (Contacts access not granted) |
| 3    | Not found                                       |
| 4    | Ambiguous ID                                    |
| 5    | Confirmation required (delete without --force)  |

## Error Handling

- If Contacts.app is not accessible, exit 2 with a clear message.
- All errors go to stderr as JSON. Stdout is reserved for data.
- No silent failures. Every error produces output.

## Testing

- Unit tests for argument parsing and JSON formatting (if the structure supports it).
- Integration tests that create, read, update, and delete a test contact, then clean up.
- Notes read/write must be covered—it's the core capability.

## File Structure

```text
cx/
├── cx           # Executable entry point (shell wrapper)
├── lib/
│   ├── contacts.js        # JXA core — Contacts.app interface
│   ├── format.js          # Text formatting (table, card)
│   └── args.js            # Argument parsing
├── tests/
│   └── ...
├── Makefile or Taskfile    # install, test
├── CLAUDE.md
└── README.md
```

The entry point is a shell script that calls `osascript -l JavaScript` with the appropriate JXA file. This keeps it installable via symlink or copy—no build step.

## Installation

```bash
# Clone and symlink
ln -s $(pwd)/cx /usr/local/bin/cx

# Or copy
cp cx /usr/local/bin/
```

## Scope Boundaries

**In scope:**

- Full CRUD on contacts and groups
- All properties including notes
- JSON and text output
- Short ID resolution
- Search

**Out of scope:**

- Contact images (read/write binary data via CLI is awkward)
- vCard import/export (use Contacts.app)
- Sync or conflict resolution
- Batch operations beyond what repeated CLI calls provide

## Open Questions

1. **Should `search` search notes content?** AppleScript's `search` may not index notes. May require fetching all contacts and filtering.
2. **Performance with large contact databases.** AppleScript is slower than CNContactStore. With 477 contacts this is likely fine. Worth testing.
3. **JXA module loading.** JXA doesn't have `require()` or `import`. The multi-file structure may need a build/concatenation step, or everything lives in one file. Needs prototyping.
