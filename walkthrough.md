# cx Walkthrough

*2026-03-27T01:27:50Z by Showboat 0.6.1*
<!-- showboat-id: dff2d9b2-f35e-4f36-bac1-b1b43873c173 -->

## Overview

`cx` is a macOS CLI for managing Apple Contacts. It uses JXA (JavaScript for Automation)
via `osascript` because Apple's `CNContactStore` blocks access to contact notes without
an entitlement that requires Apple approval and an app bundle. JXA has no such restriction.

The codebase is two files: a 7-line bash wrapper (`cx`) and a ~720-line JXA file (`cx.js`).
Everything runs through `osascript -l JavaScript`.

### File layout

```bash
find . -not -path './.git/*' -not -path './.git' -not -name walkthrough.md -not -name '.DS_Store' | sort
```

```output
.
./biome.json
./CLAUDE.md
./cx
./cx.js
./README.md
./Taskfile.yml
./tests
./tests/bench.sh
./tests/test.sh
```

## Entry Point: `cx` (bash wrapper)

The shell script resolves its real path (following symlinks), then execs `osascript`
with the JXA file. The `--` separator ensures CLI args pass through cleanly.

```bash
cat cx
```

```output
#!/usr/bin/env bash
set -euo pipefail

# Resolve real path (follow symlinks) to find cx.js
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")" && pwd)"

exec osascript -l JavaScript "$SCRIPT_DIR/cx.js" -- "$@"
```

## JXA Foundation: I/O and ObjC Bridge

JXA runs in `osascript`, which captures the return value of the last expression as stdout.
That's fine for simple scripts, but `cx` needs explicit control over stdout, stderr, and
exit codes. The first 33 lines set up the ObjC bridge for this.

`writeStdout` and `writeStderr` use Foundation's `NSFileHandle` to write to fd 1 and fd 2.
`readStdin` reads all of fd 0 for `--json` mode. `exitWithError` writes to stderr and
calls `$.exit()` from the C stdlib.

```bash
sed -n '1,33p' cx.js
```

```output
ObjC.import("Foundation");

// --- Stderr / Stdout helpers ---

function writeStderr(msg) {
	const stderr = $.NSFileHandle.fileHandleWithStandardError;
	const str = $.NSString.alloc.initWithUTF8String(`${msg}\n`);
	stderr.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
}

function writeStdout(msg) {
	const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
	const str = $.NSString.alloc.initWithUTF8String(`${msg}\n`);
	stdout.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
}

function readStdin() {
	const stdin = $.NSFileHandle.fileHandleWithStandardInput;
	const data = stdin.readDataToEndOfFile;
	const str = $.NSString.alloc.initWithDataEncoding(
		data,
		$.NSUTF8StringEncoding,
	);
	return ObjC.unwrap(str);
}

// --- Exit helper ---

function exitWithError(message, code) {
	writeStderr(`error: ${message}`);
	ObjC.import("stdlib");
	$.exit(code || 1);
}
```

## Contacts.app Helpers

`getApp()` returns the Contacts scripting bridge. `shortId()` truncates UUIDs to 8 chars.

`resolveId()` is the most interesting helper — it first tries a direct lookup by full ID,
then falls back to prefix-matching against all contacts. This fallback is the source of
the ~10s latency on `get`, `update`, `delete`, and `groups add/remove` (see Performance
section in README).

```bash
sed -n '37,83p' cx.js
```

```output
function getApp() {
	try {
		return Application("Contacts");
	} catch (_e) {
		exitWithError(
			"cannot access Contacts.app — grant access in System Settings > Privacy & Security > Automation",
			2,
		);
	}
}

function shortId(fullId) {
	return fullId.substring(0, 8);
}

function resolveId(app, idArg) {
	if (!idArg) exitWithError("missing contact ID", 1);

	// Try full ID first
	try {
		const p = app.people.byId(idArg);
		p.name(); // force evaluation — throws if not found
		return p;
	} catch (_e) {
		// Not a full ID — try short ID match
	}

	const allPeople = app.people();
	const matches = [];
	for (let i = 0; i < allPeople.length; i++) {
		if (allPeople[i].id().indexOf(idArg) === 0) {
			matches.push(allPeople[i]);
		}
	}

	if (matches.length === 0) {
		exitWithError(`no contact matching ID ${idArg}`, 3);
	}
	if (matches.length > 1) {
		const lines = [`ambiguous ID ${idArg} matches ${matches.length} contacts:`];
		for (let j = 0; j < matches.length; j++) {
			lines.push(`  ${shortId(matches[j].id())}  ${matches[j].name()}`);
		}
		exitWithError(lines.join("\n"), 4);
	}
	return matches[0];
}
```

## Text Formatting

`contactSummary()` extracts a flat object from a person for table display.
`formatTable()` renders summaries as a fixed-width columnar table.
`formatCard()` renders a full contact as a labeled card — the detailed view for `cx get`.

Note the `namePrefix` workaround at line 151: JXA throws `-1700 (Can't convert types)`
on some contacts, so it's wrapped in a try/catch IIFE.

```bash
sed -n '85,105p' cx.js
```

```output
function contactSummary(person) {
	const name = person.name() || "(no name)";
	let email = "";
	let phone = "";
	const org = person.organization() || "";

	const emails = person.emails();
	if (emails.length > 0) email = emails[0].value();

	const phones = person.phones();
	if (phones.length > 0) phone = phones[0].value();

	return {
		id: person.id(),
		shortId: shortId(person.id()),
		name: name,
		email: email,
		phone: phone,
		organization: org,
	};
}
```

```bash
sed -n '144,158p' cx.js
```

```output
	const nameFields = [
		["Name", person.name()],
		["First", person.firstName()],
		["Last", person.lastName()],
		["Middle", person.middleName()],
		[
			"Prefix",
			(() => {
				try {
					return person.namePrefix();
				} catch (_e) {
					return null;
				}
			})(),
		],
```

## Argument Parsing

`getArgs()` extracts user arguments from `$.NSProcessInfo`. The `osascript` process
receives its own args before the `--` separator; everything after is the user's input.

`parseFlags()` handles `--key value` pairs, boolean flags (`--force`, `--json`), and
repeatable flags (`--email`, `--phone`, `--url`, `--related`, `--date`) that accumulate
into arrays.

```bash
sed -n '234,270p' cx.js
```

```output
function getArgs() {
	const allArgs = ObjC.unwrap($.NSProcessInfo.processInfo.arguments);
	const args = [];
	let pastSeparator = false;
	for (let i = 0; i < allArgs.length; i++) {
		const arg = ObjC.unwrap(allArgs[i]);
		if (pastSeparator) args.push(arg);
		else if (arg === "--") pastSeparator = true;
	}
	return args;
}

function parseFlags(args, startIndex) {
	const flags = {};
	const repeatable = ["email", "phone", "url", "related", "date"];
	for (let i = startIndex; i < args.length; i++) {
		if (args[i].indexOf("--") === 0) {
			const key = args[i].substring(2);
			if (key === "force") {
				flags.force = true;
			} else if (key === "json") {
				flags.json = true;
			} else if (i + 1 < args.length) {
				i++;
				if (repeatable.indexOf(key) !== -1) {
					if (!flags[key]) flags[key] = [];
					flags[key].push(args[i]);
				} else {
					flags[key] = args[i];
				}
			} else {
				exitWithError(`flag --${key} requires a value`, 1);
			}
		}
	}
	return flags;
}
```

## Command Dispatch

`main()` reads args, dispatches to the appropriate command handler via a switch statement.
No args prints usage. Unknown commands exit with code 1.

```bash
sed -n '300,339p' cx.js
```

```output
function main() {
	const args = getArgs();
	if (args.length === 0) {
		writeStdout(USAGE);
		return;
	}

	const command = args[0];

	switch (command) {
		case "list":
			cmdList(args);
			break;
		case "search":
			cmdSearch(args);
			break;
		case "get":
			cmdGet(args);
			break;
		case "create":
			cmdCreate(args);
			break;
		case "update":
			cmdUpdate(args);
			break;
		case "delete":
			cmdDelete(args);
			break;
		case "groups":
			cmdGroups(args);
			break;
		case "help":
		case "--help":
		case "-h":
			writeStdout(USAGE);
			break;
		default:
			exitWithError(`unknown command: ${command}\n\n${USAGE}`, 1);
	}
}
```

## Multi-Value Field Helpers

`parseLabelValue()` splits `label:value` strings, with special handling for URL schemes
(`http:`, `https:`, etc.) that would otherwise be misinterpreted as labels.

`applyScalarFields()` maps CLI flag names to JXA property assignments.
`addMultiValueFields()` pushes multi-value items (emails, phones, etc.) onto the
contact using JXA constructors like `app.Email()`, `app.Phone()`.

```bash
sed -n '343,377p' cx.js
```

```output
function parseLabelValue(str, defaultLabel) {
	const colonIdx = str.indexOf(":");
	if (colonIdx > 0 && colonIdx < str.length - 1) {
		const beforeColon = str.substring(0, colonIdx);
		if (
			beforeColon === "http" ||
			beforeColon === "https" ||
			beforeColon === "tel" ||
			beforeColon === "mailto"
		) {
			return { label: defaultLabel, value: str };
		}
		return {
			label: str.substring(0, colonIdx),
			value: str.substring(colonIdx + 1),
		};
	}
	return { label: defaultLabel, value: str };
}

function applyScalarFields(person, flags) {
	if (flags.first !== undefined) person.firstName = flags.first;
	if (flags.last !== undefined) person.lastName = flags.last;
	if (flags.middle !== undefined) person.middleName = flags.middle;
	if (flags.suffix !== undefined) person.suffix = flags.suffix;
	if (flags.nickname !== undefined) person.nickname = flags.nickname;
	if (flags.maiden !== undefined) person.maidenName = flags.maiden;
	if (flags.org !== undefined) person.organization = flags.org;
	if (flags.title !== undefined) person.jobTitle = flags.title;
	if (flags.dept !== undefined) person.department = flags.dept;
	if (flags.note !== undefined) person.note = flags.note;
	if (flags.birthday !== undefined) {
		person.birthDate = new Date(flags.birthday);
	}
}
```

## Commands: List and Search

`cmdList` fetches all contacts (or a group's members) and renders them as a table.
This is the slowest command (~70s) because `contactSummary()` accesses `.emails()`,
`.phones()`, and `.organization()` individually for each of ~479 contacts.

`cmdSearch` uses Contacts.app's `whose()` predicate to filter server-side — much faster
(~1s). It does not search notes content; that was a deliberate scope decision.

```bash
sed -n '418,461p' cx.js
```

```output
function cmdList(args) {
	const flags = parseFlags(args, 1);
	const app = getApp();

	let people;
	if (flags.group) {
		const groups = app.groups.whose({ name: flags.group })();
		if (groups.length === 0)
			exitWithError(`group not found: ${flags.group}`, 3);
		people = groups[0].people();
	} else {
		people = app.people();
	}

	const summaries = [];
	for (let i = 0; i < people.length; i++) {
		summaries.push(contactSummary(people[i]));
	}

	summaries.sort((a, b) => a.name.localeCompare(b.name));

	writeStdout(formatTable(summaries));
}
function cmdSearch(args) {
	if (args.length < 2) exitWithError("usage: cx search <query>", 1);
	const query = args[1];
	const app = getApp();

	const people = app.people.whose({
		_or: [
			{ firstName: { _contains: query } },
			{ lastName: { _contains: query } },
			{ name: { _contains: query } },
			{ organization: { _contains: query } },
		],
	})();

	const summaries = [];
	for (let i = 0; i < people.length; i++) {
		summaries.push(contactSummary(people[i]));
	}

	summaries.sort((a, b) => a.name.localeCompare(b.name));

```

## Commands: Get, Create, Update, Delete

`cmdGet` resolves an ID and renders the full card. Simple — the work is in `resolveId`
and `formatCard`.

`cmdCreate` supports two input modes: CLI flags and `--json` stdin. In JSON mode, it
remaps camelCase property names (`firstName` → `first`) to match the flag namespace,
then reuses the same `applyScalarFields` and `addMultiValueFields` helpers.

`cmdUpdate` is structurally identical to create, but operates on an existing contact.

`cmdDelete` without `--force` prints a summary and exits with code 5 — a signal to
the caller (Claude Code or a human) to confirm before re-running with `--force`.

```bash
sed -n '466,475p' cx.js
```

```output
	const app = getApp();
	const person = resolveId(app, args[1]);
	writeStdout(formatCard(person));
}
function cmdCreate(args) {
	let flags = parseFlags(args, 1);
	const app = getApp();

	if (flags.json) {
		const input = readStdin().trim();
```

```bash
sed -n '590,615p' cx.js
```

```output
	const flags = parseFlags(args, 2);
	const name = person.name() || "(no name)";
	const sid = shortId(person.id());

	if (!flags.force) {
		const s = contactSummary(person);
		writeStdout(`Will delete: ${s.name} (${sid})`);
		if (s.email) writeStdout(`  Email: ${s.email}`);
		if (s.phone) writeStdout(`  Phone: ${s.phone}`);
		if (s.organization) writeStdout(`  Org:   ${s.organization}`);
		writeStdout("\nRe-run with --force to confirm.");
		ObjC.import("stdlib");
		$.exit(5);
	}

	app.delete(person);
	app.save();
	writeStdout(`Deleted ${name} (${sid})`);
}
function cmdGroups(args) {
	if (args.length < 2) exitWithError("usage: cx groups <subcommand> [args]", 1);
	const sub = args[1];
	const app = getApp();

	switch (sub) {
		case "list":
```

## Commands: Groups

`cmdGroups` dispatches to six subcommands. The key JXA gotcha here:
`app.add(person, {to: group})` is required for group membership —
`group.people.push()` throws error -1701.

`groupsDelete` uses the same `--force` confirmation pattern as `cmdDelete`.

```bash
sed -n '682,701p' cx.js
```

```output

function groupsRemove(app, contactId, groupName) {
	const person = resolveId(app, contactId);
	const groups = app.groups.whose({ name: groupName })();
	if (groups.length === 0) exitWithError(`group not found: ${groupName}`, 3);

	app.remove(person, { from: groups[0] });
	app.save();
	writeStdout(`Removed ${person.name() || "(no name)"} from ${groupName}`);
}

function groupsCreate(app, name) {
	const existing = app.groups.whose({ name: name })();
	if (existing.length > 0) exitWithError(`group already exists: ${name}`, 1);

	const group = app.Group({ name: name });
	app.groups.push(group);
	app.save();
	writeStdout(`Created group: ${name}`);
}
```

## Testing

`tests/test.sh` runs 19 integration tests against real Contacts.app data. It creates
contacts with a `CxTest_$$` prefix (PID-scoped) and cleans up via an EXIT trap.

Test count verification:

```bash
grep -c 'PASS\|FAIL' tests/test.sh
```

```output
17
```

```bash
grep -c 'assert_' tests/test.sh
```

```output
22
```

22 assert calls across usage, create, search, get, update, delete (with and without
`--force`), groups lifecycle, and error cases. The 19 passing assertions at runtime
reflect that some assertions share a test section.

## Linting and Formatting

Shell scripts (`cx`, `tests/test.sh`) are checked with `shellcheck` and `shfmt`.
`cx.js` is checked with Biome, configured with JXA globals:

```bash
cat biome.json
```

```output
{
	"$schema": "https://biomejs.dev/schemas/latest/schema.json",
	"javascript": {
		"globals": ["ObjC", "$", "Application"]
	},
	"files": {
		"includes": ["cx.js"]
	},
	"linter": {
		"enabled": true
	},
	"formatter": {
		"enabled": true
	}
}
```

## Concerns

**Performance.** `list` takes ~70s with 479 contacts. Each `contactSummary()` call
makes individual Apple Event round-trips for `.emails()`, `.phones()`, `.organization()`.
Batch property access (if JXA supports it) or limiting displayed fields would help.
`resolveId()` fetches all contacts for short ID prefix matching (~10s). A cache or
`whose()` predicate on the ID field could eliminate this.

**Positional arg parsing is fragile.** `parseFlags` only recognizes `--key value` pairs.
Positional args (the ID in `cx get <id>`, the query in `cx search <query>`) are extracted
by index in each command handler. A flag like `--force` appearing before the positional
arg would shift indices and break parsing silently.

**No `app.save()` error handling.** Every mutation calls `app.save()` but doesn't check
for failure. A locked Contacts database or sync conflict would fail silently.

**Phone/email labels display raw Apple format.** Labels like `_$!<Mobile>!$_` are passed
through to output. A label-cleaning function would improve readability.

**JSON input mode is incomplete.** `cmdCreate` handles `emails` and `phones` arrays in
JSON mode, but not `urls`, `addresses`, `socialProfiles`, `relatedNames`, `instantMessaging`,
or `customDates`. The flag-based `addMultiValueFields` handles more field types than the
JSON path does.

**Duplicate JSON-to-flag mapping.** Both `cmdCreate` and `cmdUpdate` contain identical
blocks that remap `firstName` → `first`, `lastName` → `last`, etc. This should be a
shared function.

**`exitWithError` imports stdlib on every call.** `ObjC.import("stdlib")` is called
inside `exitWithError` and in the `--force` exit paths. Moving it to the top-level
import (alongside `Foundation`) would be cleaner.

