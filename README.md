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

For complex input (addresses, social profiles), pipe JSON via stdin. JSON
*replaces* any collection it names, where flag input appends:

```bash
echo '{"firstName":"Jane","lastName":"Doe","emails":[{"label":"work","value":"jane@co.com"}]}' | cx create --json
```

### The note

The note is the field this tool exists to reach, and it has no undo. Replacing a
non-empty note echoes the previous text to stderr so it survives in scrollback,
and `--note-append` adds a line instead of replacing.

### JSON output

Every command takes `--format json` and emits the same records the text
formatters consume, so nothing has to parse columns:

```bash
cx search jane --format json
cx get a1b2c3d4 --format json
```

Exit codes: 0 success, 1 error, 2 permission denied, 3 not found, 4 ambiguous
ID, 5 confirmation required. Destructive commands print what they would do and
exit 5; re-run with `--force` to proceed.

## Why JXA?

Apple's `CNContactStore` requires the `com.apple.developer.contacts.notes` entitlement to access contact notes. This entitlement requires Apple approval and an app bundle. JXA via `osascript` has full access to all contact properties with no entitlements or signing required.

## Performance

Benchmarks with 343 contacts (2026-09-02, Apple M4):

| Command        | Time  |
| -------------- | ----- |
| list           | 0.76s |
| search (hit)   | 0.93s |
| search (miss)  | 0.50s |
| create         | 1.07s |
| get            | 0.99s |
| update         | 0.77s |
| delete         | 0.96s |
| groups create  | 0.35s |
| groups list    | 0.23s |
| groups add     | 1.20s |
| groups members | 0.31s |
| groups remove  | 1.28s |
| groups delete  | 0.34s |

Nothing is above 1.3s, and roughly half of each figure is `osascript` startup.
Earlier versions took 47s for `list` and ~10s for every command that resolved a
short ID, because each contact property was a separate Apple Event. Both paths
now ask Contacts for a whole collection at once. Run `task bench` to regenerate.

## Development

```bash
task test     # cx selftest, then the integration tests
task lint     # shellcheck + shfmt for shell, biome for JS
task fmt      # Auto-format shell scripts and JS
task bench    # Benchmark commands
```

`cx selftest` checks the pure helpers — label parsing, column fitting, date
handling, rendering — against literal inputs. It needs no automation permission
and touches no contacts. The integration suite in `tests/test.sh` does exercise
real Contacts.app data, creating and deleting contacts prefixed `CxTest_<pid>`.

Requires macOS with Contacts automation permission granted. `task lint` needs
shellcheck, shfmt and bun; `task bench` needs `gdate` from coreutils.

## License

MIT. See [LICENSE](LICENSE).
