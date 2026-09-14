# cx Walkthrough

*2026-09-14T15:50:02Z by Showboat 0.6.1*
<!-- showboat-id: 89f0e694-eaad-4750-976e-e10c92b03b2a -->

`cx` is a macOS command-line tool for reading and writing Apple Contacts. It
exists for one reason, and that reason shapes everything below: `CNContactStore`
cannot touch a contact's **note** without the
`com.apple.developer.contacts.notes` entitlement, which needs Apple's approval
and an app bundle. JXA — JavaScript for Automation, driven through `osascript` —
has full access to every contact property with no entitlement and no signing.

So the whole tool is one JXA script. JXA has no module system, no `require`, no
`import`. Everything is in one file by design, and the only structuring device
available is where a function sits in it.

This walkthrough follows a command from the shell to Contacts.app and back.

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

That is the entire executable. `cx` resolves its own symlink — it is installed
to `~/.local/bin/cx` — so it can find `cx.js` beside itself, then `exec`s
`osascript`. The bare `--` matters: without it `osascript` swallows the
arguments meant for the script.

## Architecture: two boundaries in one file

`cx.js` is about 1,480 lines with no modules, so it is organised by section
banner, and the banners draw the one line the design turns on.

```bash
grep '^// --- ' cx.js
```

```output
// --- Process I/O: stdin, stdout, stderr, argv, exit ---
// --- Pure helpers ---
// --- Contacts access ---
// --- Commands and dispatch ---
// --- Run ---
```

The load-bearing banner is **Contacts access**. Everything above it is plain
data in, plain data out — it never touches a JXA object. Everything below it
talks to Contacts.app. That single line answers the question the architecture
turns on, "does this touch Contacts?", by position rather than by reading each
body.

Inside that, a second boundary runs the other way. `read*` functions touch
Contacts and return plain records; `format*` functions take records and return
strings and must never touch a JXA object. That is what makes `--format json` a
serialiser rather than a second renderer — both formats consume the same record
— and it is what lets `cx selftest` exercise the rendering with no Contacts.app
at all.

## Entry: dispatch

`main` runs at the bottom of the file. Everything above it is declarations,
which JavaScript hoists, so the reading order and the execution order are
different — the file reads top-down but nothing executes until the last line.

```bash
sed -n '/^function main/,/^}/p' cx.js
```

```output
function main() {
	const args = getArgs();
	if (args.length === 0) {
		writeStdout(usage());
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
		case "selftest":
			cmdSelftest();
			break;
		case "version":
		case "--version":
		case "-v":
			writeStdout(`cx ${VERSION}`);
			break;
		case "help":
		case "--help":
		case "-h":
			writeStdout(usage());
			break;
		default:
			exitWithError(`unknown command: ${command}\n\n${usage()}`, 1);
	}
}
```

`getArgs` is where the `--` from the wrapper is paid back — `osascript` hands
the script its arguments through an ObjC bridge, not through `process.argv`.

```bash
sed -n '/^function getArgs/,/^}/p' cx.js
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
```

Everything the process writes goes through two functions, because JXA has no
`console.log` that reaches stdout usefully — `NSFileHandle` does the work.

```bash
sed -n '/^function writeStderr/,/^}/p' cx.js; echo; sed -n '/^function exitWithError/,/^}/p' cx.js
```

```output
function writeStderr(msg) {
	const stderr = $.NSFileHandle.fileHandleWithStandardError;
	const str = $.NSString.alloc.initWithUTF8String(`${msg}\n`);
	stderr.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
}

function exitWithError(message, code) {
	writeStderr(`error: ${message}`);
	$.exit(code || 1);
}
```

`exitWithError` is the only exit path for a failure, and the code it takes is
part of the tool's contract: 0 success, 1 error, 2 permission denied, 3 not
found, 4 ambiguous ID, 5 confirmation required. That set is the documented API —
more so than the text output — so changing what exits 4 is a breaking change.

## The catalogues

Every field `cx` knows about is one row in one of two tables. This is the
file's central claim about itself: adding a field is one row, and no consumer
gets a new case.

```bash
sed -n '/^const SCALARS = \[/,/^];/p' cx.js
```

```output
const SCALARS = [
	{ prop: "name", display: "Name" },
	{ flag: "first", prop: "firstName", display: "First" },
	{ flag: "last", prop: "lastName", display: "Last" },
	{ flag: "middle", prop: "middleName", display: "Middle" },
	// namePrefix throws -1700 on some contacts; the read stays guarded.
	{ prop: "namePrefix", display: "Prefix", guarded: true },
	{ flag: "suffix", prop: "suffix", json: "nameSuffix", display: "Suffix" },
	{ flag: "nickname", prop: "nickname", display: "Nickname" },
	{ flag: "maiden", prop: "maidenName", display: "Maiden" },
	{ flag: "org", prop: "organization", display: "Organization" },
	{ flag: "title", prop: "jobTitle", display: "Job Title" },
	{ flag: "dept", prop: "department", display: "Department" },
	{ flag: "birthday", prop: "birthDate", display: "Birthday", type: "date" },
	// Handled by applyNote, not the generic setter — see there.
	{ flag: "note", prop: "note", manual: true },
];
```

Read the keys as answers to questions each consumer asks:

- **`flag`** — the CLI spelling. Absent means `cx` renders the field but cannot
  set it. `name` and `namePrefix` have no `flag`, and that is the whole
  read-only mechanism.
- **`prop`** — the Contacts property. This is the canonical key: the change
  record built later is keyed by `prop`, not by `flag`.
- **`json`** — the payload key, only where it differs from `prop`. Exactly one
  row needs it: `suffix` is `nameSuffix` in a payload. This is a `SCALARS`
  concept; a collection's payload key is always its `coll`.
- **`type: "date"`** — routes the value through `parseDateFlag` in both
  directions.
- **`manual: true`** — the note is not set by the generic loop. It is the field
  the tool exists for and has no undo, so it gets its own writer.
- **`guarded: true`** — `namePrefix` throws JXA error `-1700` on some contacts,
  so `readCard` wraps that one read in a try/catch.

The repeatable fields are the second table.

```bash
sed -n '/^const MULTI = \[/,/^];/p' cx.js
```

```output
const MULTI = [
	{
		flag: "email",
		coll: "emails",
		ctor: "Email",
		defaultLabel: "home",
		display: "Email",
	},
	{
		flag: "phone",
		coll: "phones",
		ctor: "Phone",
		defaultLabel: "home",
		display: "Phone",
	},
	{
		flag: "url",
		coll: "urls",
		ctor: "Url",
		defaultLabel: "home",
		display: "URL",
	},
	{
		flag: "related",
		coll: "relatedNames",
		ctor: "RelatedName",
		defaultLabel: "friend",
		display: "Related",
	},
	// No flag: Contacts holds instant messages, cx only renders them.
	{ coll: "instantMessages", display: "IM" },
	{
		flag: "date",
		coll: "customDates",
		ctor: "CustomDate",
		defaultLabel: "anniversary",
		display: "Date",
		type: "date",
	},
];
```

`coll` is the Contacts collection name and doubles as the payload key. `ctor` is
the Contacts constructor — `app.Email({label, value})` — and it is also **the
writable test**: it is present on every row `cx` can construct and absent on
exactly one, `instantMessages`, which Contacts holds but `cx` has no way to
build. Writers filter on `spec.ctor`, so read-only-ness is a property of the
row rather than a case in a consumer.

Row order is card order. `readCard` and `formatCard` both loop the table, so the
order a field appears on screen is the order it appears here.

Six lookups read these tables, and each answers a different question.

```bash
sed -n '/^function multiSpecForFlag/,/^}/p' cx.js; echo; sed -n '/^function multiSpecForReplace/,/^}/p' cx.js; echo; sed -n '/^function multiSpecForPayloadKey/,/^}/p' cx.js
```

```output
function multiSpecForFlag(flag) {
	for (let i = 0; i < MULTI.length; i++) {
		if (MULTI[i].flag === flag) return MULTI[i];
	}
	return null;
}

function multiSpecForReplace(name) {
	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		if (spec.ctor && (spec.flag === name || spec.coll === name)) return spec;
	}
	return null;
}

function multiSpecForPayloadKey(key) {
	for (let i = 0; i < MULTI.length; i++) {
		if (MULTI[i].ctor && key === MULTI[i].coll) return MULTI[i];
	}
	return null;
}
```

`multiSpecForReplace` accepting either spelling is deliberate: the flags are
singular (`--email`) and the payload keys plural (`emails`), the README teaches
the plural, and `--replace emails` used to be an error raised *after* the note
had already been overwritten.

## Input: argv and stdin become one record

`parseArgs` turns argv into flags and positionals. It has no notion of order, so
a flag may appear anywhere — `cx delete --force <id>` once read `--force` as the
contact ID.

```bash
sed -n '/^function parseArgs/,/^}/p' cx.js
```

```output
function parseArgs(args, startIndex, allowed) {
	const flags = {};
	const positionals = [];
	for (let i = startIndex; i < args.length; i++) {
		if (args[i].indexOf("--") !== 0) {
			positionals.push(args[i]);
			continue;
		}
		const key = args[i].substring(2);
		if (allowed && allowed.indexOf(key) === -1) {
			exitWithError(`unknown flag for this command: --${key}`, 1);
		}
		if (key === "force") {
			flags.force = true;
		} else if (key === "json") {
			flags.json = true;
		} else if (i + 1 < args.length) {
			i++;
			if (key === "replace" || multiSpecForFlag(key)) {
				if (!flags[key]) flags[key] = [];
				flags[key].push(args[i]);
			} else {
				flags[key] = args[i];
			}
		} else {
			exitWithError(`flag --${key} requires a value`, 1);
		}
	}
	return { flags: flags, positionals: positionals };
}
```

Three behaviours to notice. `--force` and `--json` are the only booleans, so
everything else consumes the next argument. A flag in `MULTI` — or `--replace` —
accumulates into an array instead of overwriting, which is what makes repetition
work. And `allowed` is checked before anything else: a flag the command does not
read is an error, not a silent no-op.

That list comes from the catalogues, so it cannot drift from them.

```bash
sed -n '/^function flagsOf/,/^}/p' cx.js; echo; sed -n '/^const KNOWN_FLAGS = {/,/^};/p' cx.js
```

```output
function flagsOf(table) {
	const names = [];
	for (let i = 0; i < table.length; i++) {
		if (table[i].flag) names.push(table[i].flag);
	}
	return names;
}

const KNOWN_FLAGS = {
	list: ["format", "group"],
	search: ["format"],
	get: ["format"],
	delete: ["format", "force"],
	groups: ["format", "force"],
	create: ["format", "json", "group", "note-append"].concat(
		flagsOf(SCALARS),
		flagsOf(MULTI),
	),
	update: ["format", "json", "note-append", "replace"].concat(
		flagsOf(SCALARS),
		flagsOf(MULTI),
	),
};
```

Only `create` and `update` take `--json`; only `update` takes `--replace`; only
`list` takes `--group` as a filter while `create` takes it as a destination.
Those asymmetries are why the allowlist is per command rather than global.

Now the centre of the file. `buildChange` takes the parsed flags and the parsed
payload — both plain data — and returns one record. It touches nothing.

```bash
sed -n '/^function buildChange/,/^}/p' cx.js
```

```output
function buildChange(flags, payload) {
	const change = {
		scalars: {},
		note: null,
		collections: {},
		group: flags.group || null,
		format: outputFormat(flags),
	};

	// Contradictory, so refuse rather than quietly pick one. Precedence used to
	// hand --note-append the win and discard --note without a word.
	if (flags.note !== undefined && flags["note-append"] !== undefined) {
		exitWithError("--note and --note-append are mutually exclusive", 1);
	}

	for (let i = 0; i < SCALARS.length; i++) {
		const spec = SCALARS[i];
		if (!spec.flag || spec.manual) continue;
		if (flags[spec.flag] === undefined) continue;
		change.scalars[spec.prop] =
			spec.type === "date"
				? parseDateFlag(flags[spec.flag], `--${spec.flag}`)
				: flags[spec.flag];
	}

	if (flags["note-append"] !== undefined) {
		change.note = { mode: "append", text: flags["note-append"] };
	} else if (flags.note !== undefined) {
		change.note = { mode: "replace", text: flags.note };
	}

	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		if (!spec.flag || !spec.ctor || !flags[spec.flag]) continue;
		const values = flags[spec.flag];
		const items = [];
		for (let j = 0; j < values.length; j++) {
			const lv = parseLabelValue(values[j], spec.defaultLabel);
			items.push({
				label: lv.label,
				value:
					spec.type === "date"
						? parseDateFlag(lv.value, `--${spec.flag}`)
						: lv.value,
			});
		}
		change.collections[spec.coll] = { mode: "append", items: items };
	}

	// --replace empties a collection before the adds. That is also how one is
	// cleared: --replace email with no --email leaves none. It is the only
	// operation that destroys data below the person level, so an unknown name is
	// an error -- raised here, where nothing has been written yet.
	if (flags.replace) {
		for (let i = 0; i < flags.replace.length; i++) {
			const spec = multiSpecForReplace(flags.replace[i]);
			if (!spec) {
				exitWithError(
					`--replace expects a repeatable field name, got: ${flags.replace[i]}`,
					1,
				);
			}
			const existing = change.collections[spec.coll];
			change.collections[spec.coll] = {
				mode: "replace",
				items: existing ? existing.items : [],
			};
		}
	}

	if (payload !== undefined) applyPayload(change, payload);
	return change;
}
```

The record it returns is the spine of the write path:

```bash
cat <<'SHAPE'
{
  scalars:     { firstName: "Jane", birthDate: <Date> },   // keyed by spec.prop
  note:        { mode: "replace" | "append", text },
  collections: {
    emails:      { mode: "append" | "replace", items: [{label, value}] },
    customDates: { mode: "replace",            items: [{label, value: <Date>}] },
  },
  group, format
}
SHAPE
```

```output
{
  scalars:     { firstName: "Jane", birthDate: <Date> },   // keyed by spec.prop
  note:        { mode: "replace" | "append", text },
  collections: {
    emails:      { mode: "append" | "replace", items: [{label, value}] },
    customDates: { mode: "replace",            items: [{label, value: <Date>}] },
  },
  group, format
}
```

Four things are true of it, and each one used to be false.

**It is keyed by Contacts property name.** There is one key space. Flag input
and payload input used to land in two disjoint ones — `email` versus `emails` —
with four separate writers and a `source` field carried down so `cmdUpdate`
could pick a pipeline and discard the other one's input.

**Dates are `Date` objects, not strings.** Parsing is done, not deferred.

**The two dialects keep their own semantics, expressed as `mode`.** A repeated
flag appends; a payload names a collection wholesale and replaces it. Merging
the key spaces did not merge the semantics — that distinction is deliberate and
`mode` is where it now lives, as data rather than as which function ran.

**Normalisation is validation.** Every rejection above happens here, before any
Contacts call. That matters more than it looks: a JXA `push` is visible to every
other process the moment it happens, and stays visible until Contacts.app quits.
A failure after the push leaves a real, findable, half-built contact — so
"nothing that can fail may run after the push" is a correctness rule, not
tidiness.

Payload keys are resolved against the same catalogues.

```bash
sed -n '/^function applyPayload/,/^}/p' cx.js
```

```output
function applyPayload(change, payload) {
	if (
		payload === null ||
		typeof payload !== "object" ||
		Array.isArray(payload)
	) {
		exitWithError("--json expects a JSON object on stdin", 1);
	}
	const keys = Object.keys(payload);
	// cx get --format json emits a nested envelope. Diagnose it up front: it
	// carries id/name/groups too, and whichever of those came first would
	// otherwise answer with a less useful message.
	if (keys.indexOf("fields") !== -1 || keys.indexOf("multi") !== -1) {
		exitWithError(
			"cx get --format json emits a nested record that --json does not read; pass a flat object keyed by Contacts property names",
			1,
		);
	}
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const value = payload[key];

		if (key === "note" || key === "note-append") {
			if (typeof value !== "string") {
				exitWithError(`${key} must be a string`, 1);
			}
			change.note = {
				mode: key === "note" ? "replace" : "append",
				text: value,
			};
			continue;
		}

		const scalar = scalarSpecForPayloadKey(key);
		if (scalar) {
			if (typeof value !== "string") {
				exitWithError(`${key} must be a string`, 1);
			}
			change.scalars[scalar.prop] =
				scalar.type === "date" ? parseDateFlag(value, key) : value;
			continue;
		}

		const multi = multiSpecForPayloadKey(key);
		if (multi) {
			change.collections[multi.coll] = {
				mode: "replace",
				items: payloadItems(key, multi, value, change.collections[multi.coll]),
			};
			continue;
		}

		if (READ_ONLY_KEYS.indexOf(key) !== -1) {
			exitWithError(`${key} is rendered but cannot be written`, 1);
		}
		exitWithError(`unknown key in JSON payload: ${key}`, 1);
	}
}
```

The three-way fallthrough — note, scalar, collection, then error — means an
unrecognised key is never dropped. It is either written or named in an error,
which is the difference between "your payload did nothing" and "your payload had
a typo on line 3". `READ_ONLY_KEYS` names the ones `cx get` emits but nothing
can set, so the most likely mistake gets the most specific message.

You can see all of it without a contact, because none of it reaches Contacts:

```bash
echo null | ./cx create --json; echo '{"firstName":"X","addresses":[]}' | ./cx create --json; echo '{"firstName":"X","nonsense":1}' | ./cx create --json; ./cx get a1b2c3d4 --json; ./cx update a1b2c3d4 --note a --note-append b; true
```

```output
error: --json expects a JSON object on stdin
error: addresses is rendered but cannot be written
error: unknown key in JSON payload: nonsense
error: unknown flag for this command: --json
error: --note and --note-append are mutually exclusive
```

`readInput` is the only function that touches stdin, and it is deliberately
thin. The split matters for testing: stdin can never be selftested, so the logic
lives next door in `buildChange`, which can.

```bash
sed -n '/^function readInput/,/^}/p' cx.js
```

```output
function readInput(command, args, startIndex) {
	const parsed = parseArgs(args, startIndex, KNOWN_FLAGS[command]);
	let payload;
	if (parsed.flags.json) {
		const stdin = readStdin().trim();
		if (!stdin) exitWithError("--json requires JSON on stdin", 1);
		try {
			payload = JSON.parse(stdin);
		} catch (e) {
			exitWithError(`invalid JSON: ${e.message}`, 1);
		}
	}
	return {
		change: buildChange(parsed.flags, payload),
		positionals: parsed.positionals,
	};
}
```

Note `payload` is left `undefined` when `--json` was not given, which is how
`buildChange` distinguishes "no payload" from a payload of literal `null` —
`echo null | cx create --json` has to be an error, not a no-op.

## Crossing into Contacts

Everything from here talks to Contacts.app. The first call is also the one that
can be refused.

```bash
sed -n '/^function getApp/,/^}/p' cx.js; echo; sed -n '/^function isPermissionError/,/^}/p' cx.js
```

```output
function getApp() {
	const app = Application("Contacts");
	try {
		app.name();
	} catch (e) {
		if (isPermissionError(e)) {
			exitWithError(
				"cannot access Contacts.app — grant access in System Settings > Privacy & Security > Automation",
				2,
			);
		}
		throw e;
	}
	return app;
}

function isPermissionError(e) {
	if (e.errorNumber === -1743 || e.errorNumber === -10004) return true;
	return /not authori[sz]ed|not permitted|-1743/i.test(String(e.message || ""));
}
```

`app.name()` is a cheap probe whose only purpose is to make the permission
failure happen *here*, with exit 2 and a sentence naming the System Settings
pane, rather than somewhere deeper as a raw JXA error.

Resolving an ID is the next Contacts call, and it is one query rather than a
scan.

```bash
sed -n '/^function resolveId/,/^}/p' cx.js
```

```output
function resolveId(app, idArg) {
	if (!idArg) exitWithError("missing contact ID", 1);

	// One server-side prefix query handles both forms — a full UUID:ABPerson
	// id is a prefix of itself — in a single Apple Event. The previous
	// implementation fetched every person and called id() on each, which is
	// one round trip per contact and the reason get/update/delete and
	// groups add/remove all cost ~10s.
	const matches = app.people.whose({ id: { _beginsWith: idArg } })();

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

A short ID is the first 8 characters of the UUID, before the `:ABPerson`
suffix — so a full ID is a prefix of itself and `_beginsWith` accepts both forms
with no branch. The match is case-insensitive, which is why the README says
"either case". Two matches is exit 4, and that is why anything automated should
pass the full ID: an ambiguous prefix is a failure a script cannot retry out of.

```bash
sed -n '/^function shortId/,/^}/p' cx.js
```

```output
function shortId(fullId) {
	return String(fullId).substring(0, 8);
}
```

## Reading: one Apple Event, not one per contact

This is the single most consequential performance fact in the codebase, and it
is not obvious from the JXA API.

```bash
sed -n '/^function readSummaries/,/^}/p' cx.js
```

```output
function readSummaries(collection) {
	const ids = collection.id();
	const names = collection.name();
	const orgs = collection.organization();
	const emails = collection.emails.value();
	const phones = collection.phones.value();

	// Separate events, paired by index. If Contacts ever returned arrays of
	// different lengths, pairing them would attribute one person's email to
	// another, so refuse rather than guess.
	if (
		names.length !== ids.length ||
		orgs.length !== ids.length ||
		emails.length !== ids.length ||
		phones.length !== ids.length
	) {
		exitWithError("Contacts returned mismatched property arrays", 1);
	}

	const summaries = [];
	for (let i = 0; i < ids.length; i++) {
		summaries.push({
			id: ids[i],
			shortId: shortId(ids[i]),
			name: names[i] || "(no name)",
			email: emails[i] && emails[i].length > 0 ? emails[i][0] : "",
			phone: phones[i] && phones[i].length > 0 ? phones[i][0] : "",
			organization: orgs[i] || "",
		});
	}
	return summaries;
}
```

Every line in the first half fetches **one property for every contact in one
Apple Event**. `collection.id()` on a collection returns an array of every ID.
The loop afterwards only zips plain arrays together — no Contacts access at all.

The rejected alternative is the natural one: loop the people and call
`person.id()`, `person.name()` on each. That is one Apple Event per property per
contact, and it measured 47 seconds for `list` against a few hundred contacts.
Plural access takes the same work to about 0.8s.

There is a trap in it, recorded in `CLAUDE.md`, and it is why `cx search` looks
different: **plural access does not work on a `whose()` specifier.** It measured
13.3s for 256 names, worse than the per-contact loop. So search keeps the
per-contact `readSummary`.

```bash
sed -n '/^function cmdSearch/,/^}/p' cx.js
```

```output
function cmdSearch(args) {
	const parsed = parseArgs(args, 1, KNOWN_FLAGS.search);
	const format = outputFormat(parsed.flags);
	if (parsed.positionals.length === 0) {
		exitWithError("usage: cx search <query>", 1);
	}
	const query = parsed.positionals[0];
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
		summaries.push(readSummary(people[i]));
	}

	printSummaries(summaries, format);
}
```

Worth knowing as a user of the tool: that `_or` is the entire search surface.
Emails, phones, urls, related names, custom dates and **the note** are not
searched, and `name` is derived from first and last, so the effective surface is
two name fields plus the company. `cx search jane@co.com` returns `(no
contacts)` and exit 0 — indistinguishable from "not in your address book". The
tool exists to reach the note, and the note is what cannot be searched. That is
tracked as issue #11.

A single card reads far more, and one field needs protecting.

```bash
sed -n '/^function readCard/,/^	const addresses/p' cx.js | sed '$d'
```

```output
function readCard(person) {
	const fields = {};
	for (let i = 0; i < SCALARS.length; i++) {
		const spec = SCALARS[i];
		let value;
		if (spec.guarded) {
			try {
				value = person[spec.prop]();
			} catch (_e) {
				value = null;
			}
		} else {
			value = person[spec.prop]();
		}
		fields[spec.prop] =
			value && spec.type === "date" ? formatDate(value) : value;
	}

	const multi = {};
	for (let k = 0; k < MULTI.length; k++) {
		const spec = MULTI[k];
		const items = person[spec.coll]();
		const list = [];
		for (let m = 0; m < items.length; m++) {
			list.push({
				label: unwrapLabel(items[m].label() || spec.display),
				value: formatValue(items[m].value()),
			});
		}
		multi[spec.coll] = list;
	}

```

Both loops walk a catalogue, which is the "adding a field is one row" claim
being cashed in. The `spec.guarded` branch is `namePrefix` and only
`namePrefix` — JXA throws `-1700` reading it on some contacts, and a card that
crashed on one contact and not another would be a miserable bug to chase.

`unwrapLabel` handles a Contacts quirk: built-in labels come back wrapped.

```bash
sed -n '/^function unwrapLabel/,/^}/p' cx.js
```

```output
function unwrapLabel(label) {
	const m = /^_\$!<(.*)>!\$_$/.exec(label);
	return m ? m[1] : label;
}
```

`readCard` returns a plain record — `{id, fields, multi, addresses,
socialProfiles, groups}` — and that record is where Contacts stops. Everything
downstream is a pure function of it.

## Rendering: one record, two formats

`emit` is the single place that decides between rendering and serialising.

```bash
sed -n '/^function emit(/,/^}/p' cx.js
```

```output
function emit(format, data, renderText) {
	writeStdout(format === "json" ? JSON.stringify(data, null, 2) : renderText());
}
```

The text renderer is a lambda, so it is only called when the format is text —
which is what keeps `--format json` a serialiser of the same record rather than
a second renderer with its own idea of the data. Every command emits through it.

Column widths follow the data rather than being fixed.

```bash
sed -n '/^function fit/,/^}/p' cx.js
```

```output
function fit(str, len) {
	return str.length >= len
		? `${str.substring(0, len - 1)} `
		: padRight(str, len);
}
```

`fit` truncates to `len - 1` and leaves a space, so adjacent columns never run
together even when both overflow. That one-character gutter is `cx`'s own
decision rather than a language behaviour, which is why the selftest pins it.

## Dates: the one that bites

Contacts stores a date-only value at **noon local time**, and that is not an
implementation detail you can ignore.

```bash
sed -n '/^function parseDateFlag/,/^}/p' cx.js; echo; sed -n '/^function formatDate/,/^}/p' cx.js
```

```output
function parseDateFlag(str, source) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
	if (!m) {
		exitWithError(`${source} must be YYYY-MM-DD, got: ${str}`, 1);
	}
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const date = new Date(year, month - 1, day, 12, 0, 0);
	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day
	) {
		exitWithError(`${source} is not a real date: ${str}`, 1);
	}
	return date;
}

function formatDate(date) {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
```

`new Date("1990-05-14")` parses as UTC midnight, which is 13 May anywhere west
of Greenwich — so a birthday entered as the 14th was stored as the 13th. Both
functions therefore work in local components only: `parseDateFlag` builds from
`(year, month-1, day, 12, 0, 0)` and `formatDate` reads `getFullYear` and
friends, never `toISOString`. Noon gives twelve hours of slack in either
direction, so no timezone can push the date across a day boundary.

The second check catches `2026-02-30`, which the `Date` constructor silently
rolls forward to 2 March rather than rejecting.

```bash
./cx create --first X --birthday '2026-02-30'; ./cx create --first X --birthday '14 May 1990'; true
```

```output
error: --birthday is not a real date: 2026-02-30
error: --birthday must be YYYY-MM-DD, got: 14 May 1990
```

## `label:value` and the one ambiguous grammar

Every repeatable flag takes `label:value`, and the value may itself contain a
colon. That is the only genuinely ambiguous piece of input `cx` accepts.

```bash
sed -n '/^function parseLabelValue/,/^}/p' cx.js
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
```

The disambiguation is a hard-coded list of four schemes. Anything else before
the first colon becomes a label, so `--url ssh://host` stores `//host` under a
label named `ssh`, and the same happens for `ftp:`, `sip:`, `xmpp:`, `file:` and
any custom app scheme. Nothing warns. The rule the code is reaching for is "a
colon that starts a URI scheme is not a separator"; what it has is the four
schemes someone needed. That is issue #29.

## Writing

Three writers, one per part of the change record.

```bash
sed -n '/^function applyScalars/,/^}/p' cx.js; echo; sed -n '/^function applyCollections/,/^}/p' cx.js; echo; sed -n '/^function clearCollection/,/^}/p' cx.js
```

```output
function applyScalars(person, scalars) {
	const props = Object.keys(scalars);
	for (let i = 0; i < props.length; i++) {
		person[props[i]] = scalars[props[i]];
	}
}

function applyCollections(app, person, collections) {
	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		const change = collections[spec.coll];
		if (!spec.ctor || !change) continue;
		if (change.mode === "replace") clearCollection(app, person, spec);
		for (let j = 0; j < change.items.length; j++) {
			person[spec.coll].push(
				app[spec.ctor]({
					label: change.items[j].label,
					value: change.items[j].value,
				}),
			);
		}
	}
}

function clearCollection(app, person, spec) {
	const items = person[spec.coll]();
	// Backwards: deleting shifts the indices of everything after.
	for (let j = items.length - 1; j >= 0; j--) {
		app.delete(items[j]);
	}
}
```

`applyScalars` is three lines because every decision was made upstream — the
keys are already Contacts property names and the dates are already `Date`
objects. `applyCollections` is the only collection writer; `mode` tells it what
to do, so it does not know or care which dialect produced the record.
`clearCollection` iterates backwards because `app.delete` shifts the indices of
everything after it.

The note gets its own writer, for a reason worth stating.

```bash
sed -n '/^function applyNote/,/^}/p' cx.js
```

```output
function applyNote(person, note) {
	if (!note) return;
	if (note.mode === "append") {
		const existing = person.note() || "";
		person.note = existing ? `${existing}\n${note.text}` : note.text;
		return;
	}
	const existing = person.note();
	if (existing && existing !== note.text) {
		writeStderr(`previous note for ${shortId(person.id())}:\n${existing}`);
	}
	person.note = note.text;
}
```

The note is the field the tool exists for, it has no undo, and no other tool on
the machine backs it up independently. So replacing a non-empty note echoes the
previous text **to stderr** — it survives in scrollback, and stdout stays clean
for anything parsing output.

And every mutation ends the same way.

```bash
sed -n '/^function saveOrFail/,/^}/p' cx.js
```

```output
function saveOrFail(app) {
	try {
		app.save();
	} catch (e) {
		exitWithError(`changes may not have been saved: ${e.message}`, 1);
	}
}
```

What `save` actually does is worth getting right, because the answer decides
whether the ordering rules above are load-bearing. Measured, not inferred: push a
person and exit without saving, and a **separate process** finds the contact.
Quit Contacts.app and it is gone. So a mutation goes live in the running app the
moment it is made, and `save` is what persists it to disk. Neither "it persists"
nor "it is lost" is true on its own, and for a while this repository asserted
both, in different files, without flagging it.

The consequence is the ordering rule: a failure between `push` and `save` leaves
a real, findable, half-built contact for the life of the Contacts process.

## The write commands

Both are now the same three phases — plan, resolve, apply.

```bash
sed -n '/^function cmdCreate/,/^}/p' cx.js
```

```output
function cmdCreate(args) {
	const change = readInput("create", args, 1).change;

	const first = change.scalars.firstName;
	const last = change.scalars.lastName;
	const org = change.scalars.organization;
	if (!first && !last && !org) {
		exitWithError("create requires at least --first, --last or --org", 1);
	}

	const app = getApp();
	const targetGroup = change.group ? resolveGroup(app, change.group) : null;

	const personProps = {};
	if (first) personProps.firstName = first;
	if (last) personProps.lastName = last;
	// Contacts models a business as a person record flagged as a company,
	// displayed by organization rather than by name. The organization goes in at
	// push time rather than with the other scalars: until it lands the record has
	// no name and no organization at all, so nothing can find it -- not a search,
	// and not the test harness sweeping up after an interrupted run.
	if (!first && !last) {
		personProps.company = true;
		personProps.organization = org;
	}

	const person = app.Person(personProps);
	app.people.push(person);

	applyScalars(person, change.scalars);
	applyNote(person, change.note);
	applyCollections(app, person, change.collections);

	if (targetGroup) app.add(person, { to: targetGroup });

	saveOrFail(app);
	emitAction(change.format, "created", person);
}
```

Read it as three blocks. **Plan** is the first line — `readInput` does all
parsing, all normalisation, all rejection, and touches nothing. **Resolve** is
`getApp` and `resolveGroup`, which can still fail with exit 2 or 3, but nothing
has been mutated. **Apply** starts at `app.Person` and nothing in it calls
`exitWithError` except `saveOrFail`.

Two details in the middle. A business is a person record flagged `company: true`
with no personal name — that is how Contacts models it, not a `cx` invention.
And `organization` goes into `personProps` at push time rather than waiting for
`applyScalars`: otherwise there is a window where the pushed record has no name
*and* no organization, making it invisible to every search, including the test
harness sweeping up after an interrupted run.

`app.add(person, {to: group})` is required for membership. `group.people.push()`
throws `-1701`.

```bash
sed -n '/^function cmdUpdate/,/^}/p' cx.js
```

```output
function cmdUpdate(args) {
	const input = readInput("update", args, 1);
	if (input.positionals.length === 0) {
		exitWithError("usage: cx update <id> [--field value ...]", 1);
	}
	const change = input.change;
	// Otherwise a typo that parsed as nothing still reported "Updated <name>"
	// and exit 0. Exit 0 now means something changed.
	if (
		Object.keys(change.scalars).length === 0 &&
		!change.note &&
		Object.keys(change.collections).length === 0
	) {
		exitWithError("update requires at least one field to change", 1);
	}

	const app = getApp();
	const person = resolveId(app, input.positionals[0]);

	applyScalars(person, change.scalars);
	applyNote(person, change.note);
	applyCollections(app, person, change.collections);

	saveOrFail(app);
	emitAction(change.format, "updated", person);
}
```

Same three blocks, same three writers, in the same order. `cmdUpdate` used to
branch on which input dialect it received and run only that side's pipeline;
there is no branch left because there is only one record.

The empty check is what makes exit 0 mean something. A misspelled flag is
already rejected by the allowlist, but a command naming no field at all would
otherwise save nothing and report `Updated <name>`.

## Delete: read before you delete

One JXA rule shapes this whole function.

```bash
sed -n '/^	app.delete(person);/,/^}/p' cx.js
```

```output
	app.delete(person);
	saveOrFail(app);
	// id is read before the delete: reading it after throws -1728, the object
	// is gone.
	emit(
		format,
		{ action: "deleted", id: id, shortId: sid, name: name },
		() => `Deleted ${name} (${sid})`,
	);
}
```

`name`, `id` and `sid` are captured *before* `app.delete`. Reading a deleted JXA
object throws `-1728`, so the report has to be assembled from values taken while
the object still existed.

Without `--force`, `cmdDelete` prints what it would do and exits 5 — the
confirmation code — having deleted nothing. That is the same shape `groups
delete` uses.

## Selftest: what it can reach, and why

`cx selftest` runs every pure check in milliseconds with no Contacts permission
and no address book.

```bash
./cx selftest
```

```output
selftest: ok
```

Its reach is exactly the set of functions above the Contacts banner, and that is
not a coincidence — it is the same property, stated twice. Anything that takes
plain data and returns plain data can be checked here; anything that touches a
`person` cannot.

What it covers tells you where the bugs actually live: label parsing, column
fitting, date round-tripping, and the whole flag-and-payload mapping — every
rejection, every mode, every date, in both dialects. That last group is recent.
Before `buildChange` existed there was no function anywhere that took argv and
returned *what would be written*; the decision and the write were the same
statements inside `cmdCreate`, so every write-path defect could only be
confirmed by creating a real contact in someone's address book.

The integration suite is the other half, and it does exactly that.

```bash
sed -n '/^cleanup() {/,/^}/p' tests/test.sh
```

```output
cleanup() {
	local status=$?
	echo ""
	echo "--- Cleanup ---"
	# Delete by full id, never the short one: resolveId matches on a prefix and
	# exits 4 when it is ambiguous, which `|| true` would swallow -- silently
	# leaking the contact this sweep exists to remove.
	{
		"$CX" search "$TEST_PREFIX" --format json |
			/usr/bin/jq -r '.[].id' |
			while read -r id; do
				"$CX" delete "$id" --force 2>/dev/null || true
			done
	} || true
	# groups list emits a bare array of names, so the prefix match is ours to
	# make; read a whole line, since a group name may contain spaces.
	{
		"$CX" groups list --format json |
			/usr/bin/jq -r --arg p "$TEST_PREFIX" '.[] | select(startswith($p))' |
			while IFS= read -r group; do
				"$CX" groups delete "$group" --force 2>/dev/null || true
			done
	} || true
	# Say so rather than exiting quietly: a sweep that could not run is the
	# failure this whole mechanism exists to prevent.
	local left
	left=$("$CX" search "$TEST_PREFIX" --format json 2>/dev/null |
		/usr/bin/jq -r "length" 2>/dev/null) || left=""
	if [[ "${left:-0}" != "0" ]]; then
		echo "  WARNING: ${left:-?} contact(s) matching $TEST_PREFIX remain"
	fi
	return $status
}
```

`tests/test.sh` creates and deletes real contacts in the real address book,
which is why it cannot run in CI and why its cleanup is built the way it is. It
asks Contacts what exists under the run's prefix rather than replaying a list it
built as it went — a prefix is known before the first create, so it cannot be
outrun by a failure partway through.

Two details are load-bearing rather than defensive. The `|| true` around each
sweep: under `set -e` a failing command inside an `EXIT` trap aborts the *rest*
of the trap, so an unguarded contact sweep would skip group cleanup entirely and
rewrite the script's exit code. And deleting by full `id` rather than short:
`resolveId` exits 4 on an ambiguous prefix, which `|| true` would swallow —
leaking the contact the sweep exists to remove.

## Exit codes

The exit-code set is the tool's real API — more so than the text output, which
is why `--format json` exists. Every one is reachable without a contact:

```bash
for c in 'list --format yaml' 'get' 'get zzzzzzzz' 'boguscommand'; do printf '%-22s ' "cx $c"; ./cx $c >/dev/null 2>&1; echo "exit=$?"; done
```

```output
cx list --format yaml  exit=1
cx get                 exit=1
cx get zzzzzzzz        exit=3
cx boguscommand        exit=1
```

`0` success, `1` error, `2` permission denied, `3` not found, `4` ambiguous ID,
`5` confirmation required. Changing which input produces which code is a
breaking change even though nothing about the text output moved.

## Where to look first

| If you are changing… | Start at |
| --- | --- |
| a contact field — adding, renaming, making one writable | `SCALARS` / `MULTI`. One row. If you find yourself adding a case to a consumer, the row is missing a key. |
| how input is accepted or rejected | `buildChange`, and `KNOWN_FLAGS` for the flag names. Nothing below the Contacts banner should need to know. |
| how a card or table looks | `formatCard` / `formatTable`. They take records, never a `person`. |
| what a command does to Contacts | `cmdCreate` / `cmdUpdate`, and the three `apply*` writers. |
| performance | `readSummaries`. Plural access is the whole story, and it does not work on a `whose()` specifier. |

Two rules to keep if you change the write path. **Nothing that can fail may run
after `app.people.push`** — an unsaved push is visible to every other process
until Contacts.app quits, so a later failure strands a real contact. And
**every mutation ends in `saveOrFail`**, or the change never reaches disk.

Two rules to keep if you change the read path. **`read*` may touch Contacts;
`format*` may not.** That line is what makes `--format json` a serialiser rather
than a second renderer, and it is what `cx selftest` runs on.

