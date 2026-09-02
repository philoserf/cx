# cx Walkthrough

*2026-09-02T18:56:12Z by Showboat 0.6.1*
<!-- showboat-id: 1b678c19-c1ee-4599-991f-3953d1ef9650 -->

## Overview

`cx` manages Apple Contacts from the command line. It uses JXA (JavaScript for
Automation) via `osascript` because Apple's `CNContactStore` will not return a
contact's note without an entitlement that requires Apple's approval and a
signed app bundle. JXA has no such gate, so the whole tool is built on the
side door.

Two files: a seven-line bash wrapper (`cx`) and a single JXA file (`cx.js`).
JXA has no module system, so everything lives in one file, organised by
section comment.

```bash
find . -not -path './.git/*' -not -path './.git' -not -name walkthrough.md -not -name '.DS_Store' | LC_ALL=C sort
```

```output
.
./.github
./.github/workflows
./.github/workflows/checks.yml
./.github/workflows/claude.yml
./CLAUDE.md
./LICENSE
./README.md
./THEORY.md
./Taskfile.yml
./biome.json
./cx
./cx.js
./tests
./tests/bench.sh
./tests/test.sh
```

```bash
wc -l cx.js tests/test.sh
```

```output
    1234 cx.js
     418 tests/test.sh
    1652 total
```

## The two catalogues

Everything else in this walkthrough is downstream of these two tables. They are
the single definition of every contact field, in the order a card renders them,
and they are read by the argument parser, the writers, the readers, the
renderers and the usage text.

`SCALARS` holds single-valued fields. A row without `flag` is one `cx` can
render but not set; a row without `display` is rendered somewhere other than
the label column; `guarded` marks the one property that throws.

```bash
sed -n '454,476p' cx.js
```

```output
// One row per single-valued field, in card order. flag is absent where cx can
// render the field but not set it; display is absent where the field is
// rendered somewhere other than the label column. json names the payload key
// where it differs from the Contacts property name.
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

// One row per repeatable field, read by the parser, the writer, the JSON
```

`MULTI` holds the repeatable label:value fields. `ctor` names the JXA
constructor (`app.Email`, `app.Phone`); `coll` names the collection on a
person; `json` names the payload key for object-shaped JSON input. The
`instantMessages` row has no `flag` because Contacts can hold them and `cx`
only renders them.

```bash
sed -n '480,528p' cx.js
```

```output
const MULTI = [
	{
		flag: "email",
		json: "emails",
		coll: "emails",
		ctor: "Email",
		defaultLabel: "home",
		display: "Email",
	},
	{
		flag: "phone",
		json: "phones",
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

function multiSpecForFlag(flag) {
	for (let i = 0; i < MULTI.length; i++) {
		if (MULTI[i].flag === flag) return MULTI[i];
	}
	return null;
}
```

## Input: one path, two grammars

`parseArgs` splits argv into flags and positionals. Returning positionals is
what lets a flag appear anywhere — `cx delete --force <id>` used to read
`--force` as the contact ID and report a missing contact. A flag is repeatable
if `MULTI` says so, plus `--replace`, which names a field rather than being one.

```bash
sed -n '538,573p' cx.js
```

```output

// Returns the flags and the leftover positional arguments, so no command has
// to reach into args by index and a flag may appear anywhere. Before this,
// `cx delete --force <id>` treated --force as the contact ID and reported a
// missing contact.
function parseArgs(args, startIndex) {
	const flags = {};
	const positionals = [];
	for (let i = startIndex; i < args.length; i++) {
		if (args[i].indexOf("--") !== 0) {
			positionals.push(args[i]);
			continue;
		}
		const key = args[i].substring(2);
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

// Both input modes normalise into one flag-space object, and the mode travels
// beside the fields rather than inside them. Carrying it inside is what made
// --group vanish in JSON mode: cmdCreate replaced the whole flags object with
```

`readInput` is the one seam where the two input grammars meet. JSON uses
Contacts' own property names (`firstName`, `organization`); flags use short
forms (`first`, `org`). Both normalise into flag-space `fields`, and the mode
travels *beside* the data as `source` rather than inside it.

That last detail is the whole point. The previous version replaced the flags
object with the JSON payload and set `flags.json` on the user's own data to
remember the mode — which silently dropped `--group` in JSON mode, because the
object holding it was gone before the flag was read.

```bash
sed -n '575,614p' cx.js
```

```output
function readInput(args, startIndex) {
	const parsed = parseArgs(args, startIndex);
	if (!parsed.flags.json) {
		return {
			source: "flags",
			fields: parsed.flags,
			positionals: parsed.positionals,
		};
	}

	const stdin = readStdin().trim();
	if (!stdin) exitWithError("--json requires JSON on stdin", 1);
	let payload;
	try {
		payload = JSON.parse(stdin);
	} catch (e) {
		exitWithError(`invalid JSON: ${e.message}`, 1);
	}

	// Flags given alongside --json still apply; JSON wins on conflict.
	const fields = {};
	const flagKeys = Object.keys(parsed.flags);
	for (let i = 0; i < flagKeys.length; i++) {
		if (flagKeys[i] !== "json") fields[flagKeys[i]] = parsed.flags[flagKeys[i]];
	}
	const payloadKeys = Object.keys(payload);
	for (let j = 0; j < payloadKeys.length; j++) {
		const key = payloadKeys[j];
		fields[jsonKeyToFlag(key)] = payload[key];
	}

	return { source: "json", fields: fields, positionals: parsed.positionals };
}

// --- Usage ---

const VERSION = "1.0.0";

// The options sections are generated from the catalogues, so the help text
// cannot drift from the parser. It used to say "[opts]" and stop, leaving
```

## Reading: one Apple Event per property, not per contact

This is the single most consequential thing in the file. Every property access
across the JXA bridge is an Apple Event round trip, and they cost ~15-27ms
each. Asking for a property of a whole *collection* is one event regardless of
size.

`readSummaries` uses that: five events for the entire address book, against
roughly six per contact for the loop it replaced. Measured at 341 contacts,
`cx list` went from 47s to 0.8s. The length check exists because the arrays
come back from separate events and are paired by index — a silent misalignment
would attribute one person's email to another.

```bash
sed -n '235,274p' cx.js
```

```output
// One Apple Event per property for a whole collection, instead of one per
// contact per property. Measured at 341 contacts: five plural calls total
// ~0.7s, against ~48s for the equivalent per-contact loop.
//
// Only valid on an element collection — app.people, or a group's people.
// Plural access on a whose() specifier measured 13.3s for 256 names, worse
// than the loop, so cmdSearch keeps readSummary.
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

The same trick fixes ID resolution. `resolveId` was a full scan calling `id()`
on every contact — 9.5s, and the reason `get`, `update`, `delete` and both
group-membership commands all cost ~10s regardless of what they then did. It
is now one server-side prefix query, which also handles full UUIDs, since an
id is a prefix of itself.

```bash
sed -n '190,212p' cx.js
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

### Where plural access does not work

`cmdSearch` deliberately keeps the per-contact loop. Plural access on a
`whose()` specifier was measured at 13.26s for 256 names — worse than the
9.15s loop over all 341. So search pushes its predicate server-side and reads
matches one at a time, which is the right shape for a narrow match against a
large address book anyway.

```bash
sed -n '999,1024p' cx.js
```

```output
function cmdSearch(args) {
	const parsed = parseArgs(args, 1);
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
function cmdGet(args) {
```

## The read/render boundary

`read*` functions touch Contacts and return plain records. `format*` functions
take records and return text, and never touch a JXA object. `readCard` walks
both catalogues to build the record — including the one guarded read that
throws `-1700` on some contacts.

```bash
sed -n '339,372p' cx.js
```

```output
// Reading and rendering are separate: readCard turns a live Contacts object
// into a plain record, formatCard turns that record into text. Nothing below
// this line touches a JXA object, which is what makes the card renderable
// without Contacts.app — and serialisable, when --format json arrives.
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
```

`formatCard` consumes that record and nothing else. Because the record is
plain data, the same function is exercised by `cx selftest` against a literal
object, with no Contacts.app involved.

```bash
sed -n '403,442p' cx.js
```

```output
function formatCard(record) {
	const lines = [];

	lines.push(`ID:           ${shortId(record.id)} (${record.id})`);

	for (let i = 0; i < SCALARS.length; i++) {
		const spec = SCALARS[i];
		if (!spec.display) continue;
		const value = record.fields[spec.prop];
		if (value) lines.push(padRight(`${spec.display}:`, 14) + value);
	}

	for (let k = 0; k < MULTI.length; k++) {
		const items = record.multi[MULTI[k].coll];
		for (let m = 0; m < items.length; m++) {
			lines.push(padRight(`${items[m].label}:`, 14) + items[m].value);
		}
	}

	const extras = record.addresses.concat(record.socialProfiles);
	for (let e = 0; e < extras.length; e++) {
		lines.push(padRight(`${extras[e].label}:`, 14) + extras[e].value);
	}

	if (record.groups.length > 0) {
		lines.push(`Groups:       ${record.groups.join(", ")}`);
	}

	if (record.fields.note) {
		lines.push("");
		lines.push("Note:");
		lines.push(record.fields.note);
	}

	return lines.join("\n");
}

// --- Arg parsing ---

function getArgs() {
```

And because rendering is separated from reading, `--format json` is one branch
at the point of output rather than a second renderer. `emit` is the whole of
it: every command hands it the same record its formatter would have consumed.

```bash
sed -n '92,120p' cx.js
```

```output
function outputFormat(flags) {
	const format = flags.format || "text";
	if (format !== "text" && format !== "json") {
		exitWithError(`--format expects text or json, got: ${format}`, 1);
	}
	return format;
}

// Write commands report what they did. In text that is one line; in JSON it
// is the same facts a caller would otherwise parse back out of that line.
function emitAction(format, action, person) {
	const name = person.name() || "(no name)";
	const id = person.id();
	const verb = action === "created" ? "Created" : "Updated";
	emit(
		format,
		{ action: action, id: id, shortId: shortId(id), name: name },
		() => `${verb} ${name} (${shortId(id)})`,
	);
}

function emit(format, data, renderText) {
	writeStdout(format === "json" ? JSON.stringify(data, null, 2) : renderText());
}

// Every list of contacts is sorted by display name before rendering.
function printSummaries(summaries, format) {
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	emit(format, summaries, () => formatTable(summaries));
```

## Writing: validate, then mutate

Nothing that can fail may run after `app.people.push`, or a rejected create
leaves a half-built contact in the store with no save to complete it. That was
a real defect: `cx create --first X --group Nonexistent` created X and then
exited 3, and two such orphans were found in a live address book during this
work.

```bash
sed -n '44,72p' cx.js
```

```output
// Every mutation ends in a save, and a failed save loses the whole change.
// Report that as such rather than as a raw JXA error.
function saveOrFail(app) {
	try {
		app.save();
	} catch (e) {
		exitWithError(`changes may not have been saved: ${e.message}`, 1);
	}
}

// Nothing that can fail may run after app.people.push, or a partly-built
// contact is left in the store with no save to complete it. Parsing here is
// cheap and pure, so the later real parse just repeats it.
function validateFields(fields) {
	for (let h = 0; h < SCALARS.length; h++) {
		const spec = SCALARS[h];
		if (spec.type !== "date" || !spec.flag) continue;
		if (fields[spec.flag] !== undefined) {
			parseDateFlag(fields[spec.flag], spec.flag);
		}
	}
	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		if (spec.type !== "date" || !spec.flag || !fields[spec.flag]) continue;
		const values = fields[spec.flag];
		for (let j = 0; j < values.length; j++) {
			parseDateFlag(
				parseLabelValue(values[j], spec.defaultLabel).value,
				spec.flag,
```

### The note

The note is the field the tool exists to reach, and the one with no undo
anywhere on the machine. Replacing a non-empty one echoes the previous text to
stderr — stdout stays clean, so anything parsing output is unaffected — and
`--note-append` adds instead of replacing. Its `SCALARS` row is marked
`manual` so the generic setter skips it.

```bash
sed -n '877,900p' cx.js
```

```output

// The note is the field cx exists to reach — it is the whole reason for
// choosing JXA over CNContactStore — and the one no other tool on the machine
// backs up independently. Replacing a non-empty note echoes the previous text
// to stderr so it survives in scrollback; --note-append adds to it instead.
// stdout is untouched, so anything parsing output is unaffected.
function applyNote(person, fields) {
	const append = fields["note-append"];
	if (append !== undefined) {
		const existing = person.note() || "";
		person.note = existing ? `${existing}\n${append}` : append;
		return;
	}
	if (fields.note === undefined) return;
	const existing = person.note();
	if (existing && existing !== fields.note) {
		writeStderr(`previous note for ${shortId(person.id())}:\n${existing}`);
	}
	person.note = fields.note;
}

function applyScalarFields(person, fields) {
	for (let i = 0; i < SCALARS.length; i++) {
		const spec = SCALARS[i];
```

### Dates

Contacts stores a birthday as a date-only value at noon local time.
`new Date("1990-05-14")` parses as UTC midnight, which is the previous day
west of Greenwich — verified: a birthday entered as May 14 was recorded by
Contacts as "Sunday, May 13, 1990 at 12:00:00 PM". Both directions now go
through local components, and an impossible date is rejected rather than
handed to Contacts as `NaN`.

```bash
sed -n '152,180p' cx.js
```

```output

// Contacts stores a birthday as a date-only value at noon local time. Parsing
// "1990-05-14" with new Date() gives UTC midnight, which is the previous day
// in any negative UTC offset, and Contacts then records May 13. Building from
// local components at noon avoids that, and avoids the timezones that skip
// midnight entirely on a DST transition.
function parseDateFlag(str, flagName) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
	if (!m) {
		exitWithError(`--${flagName} must be YYYY-MM-DD, got: ${str}`, 1);
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
		exitWithError(`--${flagName} is not a real date: ${str}`, 1);
	}
	return date;
}

function formatDate(date) {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
```

### Removing values

Flag input appends. `--replace <field>` empties a collection first, which is
also how you clear one — `--replace email` with no `--email` leaves none. An
unknown field name is an error rather than a silent no-op, because this is the
only operation that destroys data below the person level.

JSON input takes the other convention: a payload replaces any collection it
names. The asymmetry is deliberate and now stated in both directions.

```bash
sed -n '910,945p' cx.js
```

```output
// JSON supplies emails and phones as {label, value} objects where flag input
// supplies "label:value" strings. Only JSON produces these keys.
// --replace <field> empties a collection before the append pass. That is also
// how a collection is cleared: --replace email with no --email leaves none.
// It is the only operation that destroys data below the person level, so an
// unknown field name is an error rather than a silent no-op.
function clearReplacedCollections(app, person, fields) {
	if (!fields.replace) return;
	for (let i = 0; i < fields.replace.length; i++) {
		const spec = multiSpecForFlag(fields.replace[i]);
		if (!spec) {
			exitWithError(
				`--replace expects a repeatable field name, got: ${fields.replace[i]}`,
				1,
			);
		}
		clearCollection(app, person, spec);
	}
}

function clearCollection(app, person, spec) {
	const items = person[spec.coll]();
	// Backwards: deleting shifts the indices of everything after.
	for (let j = items.length - 1; j >= 0; j--) {
		app.delete(items[j]);
	}
}

// A JSON update replaces any collection its payload names, where flag input
// appends unless told otherwise. Both semantics are now stated; before this,
// JSON update silently ignored collections altogether.
function replaceObjectCollections(app, person, fields) {
	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		if (!spec.json || !fields[spec.json]) continue;
		clearCollection(app, person, spec);
```

## The two-step --force protocol

`osascript` has no tty, so there is nothing to prompt on. Destructive commands
instead print what they would destroy and exit 5; the caller re-runs with
`--force`. This works identically for a human and for a script, and the exit
code is the signal.

```bash
sed -n '33,42p' cx.js
```

```output
}

// The two-step --force protocol: print what would be destroyed, exit 5, and
// let the caller decide. Not an error, so it does not go through stderr.
function exitAwaitingConfirmation(format) {
	if (format !== "json") writeStdout("\nRe-run with --force to confirm.");
	$.exit(5);
}

// --- Contacts.app helpers ---
```

## Permission

`Application("Contacts")` is lazy — it builds a proxy without contacting
anything, so a permission denial can never surface there. The try/catch that
used to sit around it was dead code, and the documented exit code 2 was
unreachable. The probe now makes one real access and classifies what comes
back.

```bash
sed -n '122,150p' cx.js
```

```output

// Application() is lazy: it builds a proxy without contacting Contacts, so a
// permission denial never surfaced in the try/catch that used to be here.
// Force one cheap real access instead, so a TCC refusal is caught where it
// actually happens and reported as exit 2 with the message written for it,
// rather than as a raw JXA error on whatever the command touched first.
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

function shortId(fullId) {
	return String(fullId).substring(0, 8);
```

## Testing

Two layers. `cx selftest` checks the pure helpers against literal inputs —
label parsing, column fitting, date round-tripping, key aliasing, and both
renderers. It needs no automation permission, touches no contact, and runs in
milliseconds, so `task test` runs it first and a logic regression fails
immediately rather than minutes in.

```bash
./cx selftest
```

```output
selftest: ok
```

```bash
sed -n '669,690p' cx.js
```

```output
function cmdSelftest() {
	const failures = [];
	const check = (label, actual, expected) => {
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a !== e)
			failures.push(`${label}\n    expected ${e}\n    got      ${a}`);
	};

	check(
		"parseLabelValue splits on the first colon",
		parseLabelValue("work:a@b.com", "home"),
		{ label: "work", value: "a@b.com" },
	);
	check(
		"parseLabelValue falls back to the default label",
		parseLabelValue("a@b.com", "home"),
		{ label: "home", value: "a@b.com" },
	);
	check(
		"parseLabelValue leaves a URL scheme alone",
		parseLabelValue("https://example.com", "home"),
```

`tests/test.sh` is the integration layer, exercising real Contacts.app data
with PID-scoped `CxTest_<pid>` names and an EXIT trap for cleanup. For a tool
whose entire risk surface is Apple Event behaviour, mocking would test the
mock.

```bash
grep -c 'assert_' tests/test.sh
```

```output
75
```

```bash
grep -o '=== [A-Za-z() -]* ===' tests/test.sh | sort -u
```

```output
=== Ambiguous ID ===
=== Company contact ===
=== Create (--group) ===
=== Create (JSON) ===
=== Create (validation) ===
=== Create ===
=== Dates ===
=== Delete (force) ===
=== Delete (no force) ===
=== Error Cases ===
=== Flag before positional ===
=== Get ===
=== Groups ===
=== JSON output ===
=== List ===
=== Multi-value fields ===
=== Note protection ===
=== Replace ===
=== Results ===
=== Search ===
=== Update (JSON) ===
=== Update ===
=== Usage ===
```

## Performance, measured

Every figure in this document came from `task bench`, not from reading the
code. That distinction matters: an earlier design document asserted the ID
scan was structural and could only be fixed with a cache and a state file, and
that structured output would mean touching every formatter. Both claims were
inferred rather than measured, and both were wrong.

```bash
cat <<'TABLE'
                 before    after
list             47.0s     0.76s
get               8.9s     0.99s
update           10.6s     0.77s
delete            7.9s     0.96s
groups add       10.2s     1.20s
groups remove     9.2s     1.28s
search (hit)      1.0s     0.93s
TABLE
```

```output
                 before    after
list             47.0s     0.76s
get               8.9s     0.99s
update           10.6s     0.77s
delete            7.9s     0.96s
groups add       10.2s     1.20s
groups remove     9.2s     1.28s
search (hit)      1.0s     0.93s
```
