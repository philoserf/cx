# cx

![Status: Stable](https://img.shields.io/badge/Status-Stable-brightgreen.svg)

A macOS command-line tool for managing Apple Contacts. Built with JXA (JavaScript for Automation) for full access to all contact properties, including notes.

## Install

```bash
task install
```

This symlinks `cx` to `~/.local/bin/cx`.

## Usage

```text
cx list [--group <name>]              List contacts
cx search <query>                     Search names, orgs, emails, phones, notes
cx get <id>                           Show contact details
cx create (--first|--last|--org) ...  Create contact
cx update <id> [--field value ...]    Update contact
cx delete <id> [--force]              Delete contact
cx groups list|members|add|remove|create|delete
cx selftest                           Check the pure helpers
cx --version
```

`cx help` prints every flag, generated from the field definitions in `cx.js` so
it cannot drift from what the parser accepts.

Use short IDs (first 8 characters, either case) or full UUIDs.

### Multi-value fields

Repeat flags for multiple values. Use `label:value` syntax:

```bash
cx create --first Jane --last Doe --email work:jane@co.com --email home:jane@home.com
```

Flag input appends. `--replace <field>` empties a collection first, which is
also how you clear one:

```bash
cx update a1b2c3d4 --replace email --email work:new@co.com   # exactly one email
cx update a1b2c3d4 --replace phone                           # no phones left
```

`--replace` takes either spelling — the flag name (`email`) or the payload key
(`emails`). It is validated before anything is written, so a name it does not
recognise is an error that leaves the contact untouched.

Pipe JSON via stdin to set labels without shell quoting, or several fields in
one call. JSON _replaces_ any collection it names, where flag input appends:

```bash
echo '{"firstName":"Jane","lastName":"Doe","emails":[{"label":"work","value":"jane@co.com"}]}' | cx create --json
```

The payload is a flat object keyed by Contacts property names — `firstName`,
`organization`, `emails`, `urls`, `relatedNames`, `customDates`. Flags given
alongside `--json` still apply. Where both name the same collection the
payload's replace wins and both sets of values land in it; where only a flag
names one, it appends as usual.

**Addresses, social profiles and instant messages are rendered but not
writable.** `cx get` shows them; no input mode sets them, and a payload naming
one is rejected rather than silently dropped. Contacts models an address as a
record of street, city, state, zip and country rather than the `label`/`value`
pair every writable collection uses, so it needs a shape `cx` does not have.

### Search

`cx search` matches, case-insensitively, against the name, first and last name,
organization, note, **every** email address and **every** phone number — not
just the first of each. Labels are not matched, so `cx search work` does not
return every contact with a work email.

Accents count: `Calderon` does not find `Calderón`. That is Contacts' own
behaviour, kept deliberately so the match rule did not change when the
implementation did.

Addresses, social profiles and instant messages are not searched, and neither
are urls, related names or custom dates.

### The note

The note is the field this tool exists to reach, and it has no undo. Replacing a
non-empty note echoes the previous text to stderr so it survives in scrollback,
and `--note-append` adds a line instead of replacing. The two are contradictory,
so giving both in one call is an error rather than a silent win for one of them.

### JSON output

Every command takes `--format json` and emits the same records the text
formatters consume, so nothing has to parse columns:

```bash
cx search jane --format json
cx get a1b2c3d4 --format json
```

`--format json` is an **output** format only, and does not round trip.
`cx get --format json` emits a nested record — `id`, `fields`, `multi`,
`addresses`, `socialProfiles`, `groups` — which is the shape the renderers
consume, not the flat shape `--json` reads. Piping one into the other is an
error naming the mismatch rather than a command that exits 0 having changed
nothing.

Exit codes: 0 success, 1 error, 2 permission denied, 3 not found, 4 ambiguous
ID, 5 confirmation required. Destructive commands print what they would do and
exit 5; re-run with `--force` to proceed.

A flag a command does not read is an error, and so is an update that names no
field, so exit 0 from a write always means something changed. Every input is validated before Contacts
is opened, so a command rejected for bad input has written nothing.

## Why JXA?

Apple's `CNContactStore` requires the `com.apple.developer.contacts.notes` entitlement to access contact notes. This entitlement requires Apple approval and an app bundle. JXA via `osascript` has full access to all contact properties with no entitlements or signing required.

## Performance

Benchmarks with 340 contacts (2026-09-14, Apple M4):

| Command        | Time  |
| -------------- | ----- |
| list (cold)    | 0.85s |
| list (warm)    | 0.79s |
| create         | 1.06s |
| search (hit)   | 1.14s |
| search (miss)  | 1.16s |
| search (broad) | 1.11s |
| get            | 0.95s |
| update         | 0.53s |
| delete         | 1.03s |
| groups create  | 0.43s |
| groups list    | 0.22s |
| groups add     | 1.35s |
| groups members | 0.36s |
| groups remove  | 1.30s |
| groups delete  | 0.29s |

Every command is a handful of Apple Events rather than one per contact per
property, so the figures track the size of the address book and not the size of
the result. Earlier versions took 47s for `list`, ~10s for every command that
resolved a short ID, and 55s for a search matching most of the book.

The three search rows are the same figure on purpose, and that equality is the
measurement: a hit, a miss and a query matching 286 of 340 contacts all cost
what the fetch costs. Search is constant in the number of matches and linear in
the size of the address book; it used to be the other way round.

Run `task bench` to regenerate.

## Development

```bash
task test     # cx selftest, then the integration tests
task lint     # shellcheck + shfmt for shell, biome for JS
task fmt      # Auto-format shell scripts and JS
task bench    # Benchmark commands
```

`cx selftest` checks the pure helpers against literal inputs — label parsing,
column fitting, date handling, rendering, and the whole flag-and-payload mapping
that turns argv and stdin into a change record. It needs no automation
permission and touches no contacts.

The integration suite in `tests/test.sh` does exercise real Contacts.app data,
creating contacts prefixed `CxTest_<pid>_`. It cleans up by searching that
prefix rather than by replaying a list it built as it went, so an interrupted or
failed run still leaves the address book as it found it.

Requires macOS with Contacts automation permission granted. `task lint` needs
shellcheck, shfmt and bun; `task bench` needs `gdate` from coreutils.

## License

MIT. See [LICENSE](LICENSE).
