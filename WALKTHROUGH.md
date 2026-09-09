# cx Walkthrough

*2026-09-09T20:42:18Z by Showboat 0.6.1*
<!-- showboat-id: a0829034-aa1c-42f5-86c8-f1107ed04070 -->

## Overview

`cx` is a macOS command-line tool for managing Apple Contacts. It exists to reach one
field. `CNContactStore`, the native API, will not return a contact's **note** without the
`com.apple.developer.contacts.notes` entitlement, which needs a signed app bundle and
Apple's approval. AppleScript's object model, reached through `osascript -l JavaScript`,
has no such restriction and needs no signing at all. So `cx` is written in JXA
(JavaScript for Automation) and talks to Contacts.app the way a script would.

That choice sets the constraints for everything below. JXA has no module system — no
`require`, no `import` — so the whole program is one file. Every call into Contacts is an
Apple Event with real latency, so the difference between asking for one property and asking
for a thousand is the difference between 0.8 seconds and 47. And there is no tty, so
anything that would normally prompt has to be a two-step protocol instead.

The repository is small enough to hold in your head.

```bash
git ls-files ':!:WALKTHROUGH.md'
```

```output
.github/workflows/checks.yml
.github/workflows/claude.yml
CLAUDE.md
LICENSE
README.md
THEORY.md
Taskfile.yml
biome.json
cx
cx.js
tests/bench.sh
tests/test.sh
```

```bash
wc -l cx cx.js tests/test.sh tests/bench.sh
```

```output
       7 cx
    1234 cx.js
     418 tests/test.sh
      88 tests/bench.sh
    1747 total
```

## The entry point

`cx` is the only executable. It is seven lines of bash whose entire job is to find `cx.js`
and hand it to `osascript`.

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

Two details carry weight. The `readlink -f`/`realpath` dance exists because `task install`
symlinks this script into `~/.local/bin/cx`; without resolving the link, `SCRIPT_DIR` would
be `~/.local/bin` and `cx.js` would not be there. And the `--` before `"$@"` is mandatory:
`osascript` consumes its own arguments up to that separator, so everything the user typed
has to arrive after it.

The JXA side pays for that separator immediately. `NSProcessInfo` reports the *full*
argument vector — `osascript`, `-l`, `JavaScript`, the script path, `--`, then the user's
arguments — so `getArgs` has to skip forward to the separator before it can see anything.

```bash
sed -n '442,452p' cx.js
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

`main` is a plain switch over the first surviving argument, and the file ends by calling it.

```bash
sed -n '807,854p' cx.js
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

## The two catalogues

Before any command makes sense, you need the two tables in the middle of the file. `SCALARS`
and `MULTI` are the single definition of every contact field `cx` knows about, listed in the
order a contact card renders them.

```bash
sed -n '454,474p' cx.js
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
```

Read the absent keys, not the present ones — each omission means something.

- No `flag`: `cx` can render the field but not set it. `name` is derived by Contacts from
  the parts; `namePrefix` has no setter here at all.
- No `display`: the field is rendered somewhere other than the label column. `note` gets its
  own block at the bottom of a card, which is why it has no display name.
- `json`: the payload key when it differs from the Contacts property. Only `suffix` needs
  one — a JSON caller writes `nameSuffix`, a flag user writes `--suffix`.
- `type: "date"`: routes the value through `parseDateFlag` instead of assigning it raw.
- `manual: true`: skip the generic setter entirely. Only `note` has it, and the reason is
  further down.
- `guarded: true`: wrap the *read* in a try/catch. Only `namePrefix` has it, because
  reading it throws JXA error `-1700` on some contacts. It is not dead code and it is not
  removable.

`MULTI` is the same idea for the repeatable fields — the ones a person can have several of.

```bash
sed -n '476,521p' cx.js
```

```output
// One row per repeatable field, read by the parser, the writer, the JSON
// collection writer and the renderer. Adding a field is one row; before this
// it was four edits in four places, and missing one gave a field that parsed
// but never rendered. Order here is the order they appear on a card.
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
```

`coll` is the Contacts collection property, `ctor` the constructor used to build a new
entry (`app.Email({label, value})`), `defaultLabel` what to use when the user gives a bare
value. `instantMessages` has neither `flag` nor `ctor`: Contacts holds them, `cx` renders
them, and nothing writes them.

The payoff is that the argument parser, the field writers, the card renderer, the JSON key
aliasing and the help text are all loops over these two tables. Adding a field is one row.
Two small lookups are the whole interface to them.

```bash
sed -n '523,537p' cx.js
```

```output
function multiSpecForFlag(flag) {
	for (let i = 0; i < MULTI.length; i++) {
		if (MULTI[i].flag === flag) return MULTI[i];
	}
	return null;
}

// JSON input uses Contacts' own property names; flag input uses short forms.
function jsonKeyToFlag(key) {
	for (let i = 0; i < SCALARS.length; i++) {
		const spec = SCALARS[i];
		if (spec.flag && (key === spec.prop || key === spec.json)) return spec.flag;
	}
	return key;
}
```

One asymmetry worth carrying forward: `email` and `phone` have a `json` key, and the other
four rows do not. The JSON collection writers filter on exactly that key, so a payload
naming `urls` or `customDates` is parsed and then dropped. See
`.issues/json-input-ignores-url-related-and-date-collections.md`.

## Input: two grammars, one shape

`parseArgs` turns `argv` into a flags object plus leftover positionals. Nothing reaches into
`args` by index, so a flag can appear anywhere on the line.

```bash
sed -n '539,569p' cx.js
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
```

Three cases in one loop. `--force` and `--json` are booleans. A flag whose name is in `MULTI`
— or the literal `replace` — accumulates into an array, which is what makes
`--email a --email b` work. Everything else takes the next argument as its value.

Above that sits `readInput`, the seam between the two input grammars. Flags use short forms
(`--first`, `--org`, `--title`); JSON payloads use Contacts' own property names
(`firstName`, `organization`, `jobTitle`). Both normalise into the same flag-space object.

```bash
sed -n '571,607p' cx.js
```

```output
// Both input modes normalise into one flag-space object, and the mode travels
// beside the fields rather than inside them. Carrying it inside is what made
// --group vanish in JSON mode: cmdCreate replaced the whole flags object with
// the payload, so the flag the user typed was gone by the time it was read.
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
```

The return value is `{source, fields, positionals}`, and the placement of `source` is the
whole point. The mode travels *beside* the data, not inside it. An earlier version smuggled
it in as `flags.json` and had `cmdCreate` replace the entire flags object with the payload —
which silently discarded `--group`, because the flag the user typed was gone by the time
anything read it. `tests/test.sh` carries the regression for that.

The two modes are not merely two spellings, and the difference is deliberate: **flag input
appends** to a collection, while **JSON input replaces** any collection its payload names.
`--replace <field>` is how flag input clears one. Keep that pair in mind; it is the reason
`cmdUpdate` still branches on `source` further down.

## Getting hold of Contacts

Every command that touches data starts with `getApp`. It looks defensive and is actually
load-bearing.

```bash
sed -n '120,147p' cx.js
```

```output
	emit(format, summaries, () => formatTable(summaries));
}

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
```

`Application("Contacts")` is lazy — it builds a proxy without sending a single Apple Event —
so a try/catch around *it* never fires. The permission denial happens on the first real
access, which used to be whatever the command touched first, and surfaced as a raw JXA
error. `getApp` forces one cheap access (`app.name()`) so the refusal lands here, gets
classified by `isPermissionError`, and exits 2 with a message that tells the user which
System Settings pane to open.

`isPermissionError` checks `-1743` and `-10004` and then falls back to matching the message
text, which reads like someone who was not certain the error number was stable.

## Identifiers: short and full

A Contacts UUID looks like `2A6F…-…:ABPerson`. Nobody types that, so `cx` shows and accepts
the first eight characters. `resolveId` is the single place that turns either form into a
person.

```bash
sed -n '190,211p' cx.js
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

The trick is that a full id is a prefix of itself, so one `_beginsWith` query serves both
forms. It is a server-side query — one Apple Event — where the previous implementation
fetched every person and called `id()` on each, one round trip per contact, which is why
`get`, `update`, `delete` and both `groups` membership commands all used to cost about ten
seconds.

A truncated identifier can collide, and that possibility is part of the contract rather
than an edge case: more than one match lists the candidates and exits **4**. Every command
taking a contact id goes through this function, and bypassing it for speed would silently
drop the ambiguity check.

## Reading: one Apple Event per property, not per contact

This is the single most consequential idea in the file, and it is invisible unless you know
what a JXA property access costs. `person.id()` is an Apple Event. Doing that in a loop over
343 contacts is 343 round trips. But `app.people.id()` — the plural form, on a *collection* —
is **one** event that returns every id as an array.

`readSummaries` is built entirely around that.

```bash
sed -n '235,273p' cx.js
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

Five plural calls, then a zip by index. Measured at 341 contacts that is roughly 0.7s
against roughly 48s for the equivalent per-contact loop, and it is why `cx list` dropped
from 47 seconds to under one.

The length check is not paranoia about a hypothetical. The five arrays come back from five
*separate* events, and pairing arrays of different lengths would attribute one person's
email to another — a silent, entirely plausible-looking corruption. The code refuses rather
than guesses.

There is a catch, and only measurement finds it: plural access works on an element
collection — `app.people`, or a group's `people` — but **not** on a `whose()` specifier,
where it measured 13.3s for 256 names, worse than the loop it was meant to replace. So the
per-contact reader survives, for search.

```bash
sed -n '213,233p' cx.js
```

```output
function readSummary(person) {
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

`readSummary` and `readSummaries` produce the same record shape by different means. They
look like duplication and are not: deleting either one costs an order of magnitude
somewhere. `cmdList` and `groupsMembers` get a collection and use the plural reader;
`cmdSearch` gets a `whose()` result and uses the singular one.

```bash
sed -n '988,1022p' cx.js
```

```output
function cmdList(args) {
	const flags = parseArgs(args, 1).flags;
	const format = outputFormat(flags);
	const app = getApp();

	const collection = flags.group
		? resolveGroup(app, flags.group).people
		: app.people;

	printSummaries(readSummaries(collection), format);
}
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
```

Both hand off to `printSummaries`, which sorts by display name and then makes the one
decision that keeps text and JSON honest.

```bash
sed -n '89,120p' cx.js
```

```output
// One place decides between rendering and serialising, so --format json is a
// serialiser rather than a second renderer. Every command emits the same
// records its formatters consume.
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

## The read/render boundary

`emit` is where `--format json` lives, and it is a single branch because of a rule the file
holds to everywhere: **`read*` functions touch Contacts and return plain records; `format*`
functions take records and return text, and never touch a JXA object.**

That is what makes JSON a *serialiser* rather than a second renderer — the JSON a caller
receives is the same record the text formatter consumed, so the two can never disagree. It
is also what makes half the program testable with no Contacts.app at all.

`readCard` is the read side for a single contact, and it is a loop over the two catalogues.

```bash
sed -n '339,373p' cx.js
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
	}
```

`spec.guarded` is the `namePrefix` try/catch, and `spec.type === "date"` converts a JXA
`Date` to a `YYYY-MM-DD` string before it crosses the boundary — so nothing downstream ever
holds a live object.

Addresses and social profiles are read a few lines further on, hand-rolled rather than
catalogue-driven, because neither fits the `{label, value}` shape every `MULTI` row assumes:
an address has street/city/state/zip and a derived `formattedAddress`, a social profile has
a service name and a user name. That is also why neither can be *written* —
see `.issues/docs-claim-json-writes-addresses-and-social-profiles.md`.

`formatCard` is the render side, and it never mentions a field by name.

```bash
sed -n '403,440p' cx.js
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
```

The `unwrapLabel` call in `readCard` handles a Contacts quirk: built-in labels come back
wrapped as `_$!<Mobile>!$_`, while a label the user typed passes through untouched.

`formatTable` is the other renderer, for lists. It sizes its columns to the data rather than
to fixed widths.

```bash
sed -n '275,300p' cx.js
```

```output
function formatTable(summaries) {
	if (summaries.length === 0) return "(no contacts)";

	// Widths follow the data rather than being fixed at 10/30/30/18, so a long
	// email is no longer cut without a trace. Capped so one outlier cannot push
	// the table off the far side of a terminal. The last column is unpadded and
	// uncapped, as it always was.
	const columns = [
		{ header: "ID", key: "shortId", max: 10 },
		{ header: "Name", key: "name", max: 34 },
		{ header: "Email", key: "email", max: 36 },
		{ header: "Phone", key: "phone", max: 20 },
		{ header: "Organization", key: "organization" },
	];

	for (let c = 0; c < columns.length - 1; c++) {
		let width = columns[c].header.length;
		for (let i = 0; i < summaries.length; i++) {
			const value = summaries[i][columns[c].key] || "";
			if (value.length > width) width = value.length;
		}
		columns[c].width = Math.min(width, columns[c].max) + 2;
	}

	const row = (values) => {
		let line = "";
```

Each column is capped so one very long organisation name cannot push the table off the far
side of a terminal, and the last column is neither padded nor capped. `fit` does the work.

```bash
sed -n '319,336p' cx.js
```

```output
function padRight(str, len) {
	return str.length >= len ? str : str + " ".repeat(len - str.length);
}

// Pads to a column width, or truncates to it keeping one space as a gutter.
// Character counts assume one column per UTF-16 unit, so CJK and emoji names
// misalign; that is accepted for a personal tool rather than fixed.
function fit(str, len) {
	return str.length >= len
		? `${str.substring(0, len - 1)} `
		: padRight(str, len);
}

// Contacts wraps its built-in labels as _$!<Mobile>!$_. A label the user
// typed passes through unchanged.
function unwrapLabel(label) {
	const m = /^_\$!<(.*)>!\$_$/.exec(label);
	return m ? m[1] : label;
```

Truncation keeps one space as a gutter so adjacent columns never run together. The
character count assumes one terminal column per UTF-16 unit, so CJK and emoji names
misalign — a stated limit for a personal tool, not an oversight.

## Writing: validate, then mutate

The write path has one rule, and it is written down in the file: **nothing that can fail may
run after the person is pushed into the store.** A JXA `push` puts a partly-built contact in
Contacts immediately; if the next line exits, that half-contact stays there with no
save to complete it and no id ever returned to the caller, so nothing can clean it up.

```bash
sed -n '54,76p' cx.js
```

```output
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
			);
		}
	}
}
```

`validateFields` is a dry run: it parses every date the input carries, throws the result
away, and lets the real parse repeat the work later. It is cheap, it is pure, and it runs
before anything is created.

`cmdCreate` shows the ordering it protects.

```bash
sed -n '1032,1061p' cx.js
```

```output
function cmdCreate(args) {
	const fields = readInput(args, 1).fields;

	if (!fields.first && !fields.last && !fields.org) {
		exitWithError("create requires at least --first, --last or --org", 1);
	}

	const app = getApp();
	validateFields(fields);
	const targetGroup = fields.group ? resolveGroup(app, fields.group) : null;

	const personProps = {};
	if (fields.first) personProps.firstName = fields.first;
	if (fields.last) personProps.lastName = fields.last;
	// Contacts models a business as a person record flagged as a company,
	// displayed by organization rather than by name.
	if (!fields.first && !fields.last) personProps.company = true;

	const person = app.Person(personProps);
	app.people.push(person);

	applyScalarFields(person, fields);
	applyNote(person, fields);
	addMultiValueFields(app, person, fields);
	addObjectCollections(app, person, fields);

	if (targetGroup) app.add(person, { to: targetGroup });

	saveOrFail(app);
	emitAction(outputFormat(fields), "created", person);
```

Read that ordering carefully. The required-name check, `validateFields`, and `resolveGroup`
all run *before* `app.people.push`. Each was hoisted there in response to a real orphan: a
bad `--birthday` or a nonexistent `--group` used to leave a contact behind that no cleanup
could find. `tests/test.sh` asserts both cases exit non-zero and that a subsequent search
finds nothing.

Two things do not fit the rule. `personProps.company = true` when there is no personal name
is how Contacts models a business — a person record flagged as a company, displayed by
organisation. And the very last line calls `outputFormat` *after* the save, so
`cx create --format yaml` creates the contact and then reports an error; see
`.issues/format-validated-after-mutation-in-create-and-update.md`.

Every mutation ends the same way.

```bash
sed -n '45,52p' cx.js
```

```output
// Report that as such rather than as a raw JXA error.
function saveOrFail(app) {
	try {
		app.save();
	} catch (e) {
		exitWithError(`changes may not have been saved: ${e.message}`, 1);
	}
}
```

Without the save the change dies in scripting-bridge limbo, and a failed save loses the
whole change rather than part of it — which is why it is reported in those words rather than
as a raw JXA error.

### The note

`note` is the field this whole program exists to reach, and it is the one `SCALARS` row
marked `manual: true`.

```bash
sed -n '878,896p' cx.js
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
```

There is no undo, and nothing else on the machine backs a contact note up independently. So
replacing a non-empty note echoes the previous text to **stderr** before overwriting it — a
backup mechanism disguised as a log line, deliberately on stderr so that anything parsing
stdout is unaffected. `--note-append` is the non-destructive form. The integration suite
asserts both halves: that the old note does *not* appear on stdout, and that it *does*
appear on stderr.

Every other scalar goes through the generic setter, which is a loop over `SCALARS` that
skips exactly the rows marked `manual`.

```bash
sed -n '898,908p' cx.js
```

```output
function applyScalarFields(person, fields) {
	for (let i = 0; i < SCALARS.length; i++) {
		const spec = SCALARS[i];
		if (!spec.flag || spec.manual) continue;
		if (fields[spec.flag] === undefined) continue;
		person[spec.prop] =
			spec.type === "date"
				? parseDateFlag(fields[spec.flag], spec.flag)
				: fields[spec.flag];
	}
}
```

### Dates

A contact birthday is a date-only value, and Contacts stores it at noon local time.
`new Date("1990-05-14")` parses as UTC midnight, which is the *previous day* anywhere west
of Greenwich — so a birthday typed as the 14th was recorded as the 13th.

```bash
sed -n '152,182p' cx.js
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
}

```

Building from local components at noon fixes both the offset problem and the timezones that
skip midnight entirely on a DST transition. The round-trip check afterwards is what rejects
`2026-02-30`, which `new Date` would have happily rolled forward into March.

`--birthday` and `--date` both go through it, and `formatDate` is its inverse on the render
side. `tests/test.sh` carries the regression.

### Labels

Every repeatable flag takes `label:value`, and the value may itself contain a colon.

```bash
sed -n '858,876p' cx.js
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

The scheme list is what stops `--url https://example.com` storing `//example.com` under a
label called `https`. It is also a closed list of four, so any other scheme is split —
see `.issues/label-detection-uses-a-closed-scheme-list.md`.

### Adding and removing collection values

Flag input appends, and the writer is another loop over `MULTI`.

```bash
sed -n '966,986p' cx.js
```

```output
function addMultiValueFields(app, person, fields) {
	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		if (!spec.flag || !fields[spec.flag]) continue;
		const values = fields[spec.flag];
		for (let j = 0; j < values.length; j++) {
			const lv = parseLabelValue(values[j], spec.defaultLabel);
			person[spec.coll].push(
				app[spec.ctor]({
					label: lv.label,
					value:
						spec.type === "date"
							? parseDateFlag(lv.value, spec.flag)
							: lv.value,
				}),
			);
		}
	}
}

// --- Commands ---
```

`--replace <field>` is how flag input clears a collection before appending — and, with
nothing to append, how you empty one.

```bash
sed -n '910,939p' cx.js
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
```

Deleting backwards matters: `app.delete` shifts the index of everything after it. And an
unrecognised field name is an error rather than a silent no-op, because this is the only
operation that destroys data below the person level — a typo'd `--replace emails` that did
nothing would be a much worse outcome than one that fails loudly.

`cmdUpdate` is where the two input grammars finally diverge in behaviour.

```bash
sed -n '1063,1084p' cx.js
```

```output
function cmdUpdate(args) {
	const input = readInput(args, 1);
	if (input.positionals.length === 0) {
		exitWithError("usage: cx update <id> [--field value ...]", 1);
	}
	const app = getApp();
	const person = resolveId(app, input.positionals[0]);
	const fields = input.fields;

	validateFields(fields);
	applyScalarFields(person, fields);
	applyNote(person, fields);

	if (input.source === "flags") {
		clearReplacedCollections(app, person, fields);
		addMultiValueFields(app, person, fields);
	} else {
		replaceObjectCollections(app, person, fields);
	}

	saveOrFail(app);
	emitAction(outputFormat(fields), "updated", person);
```

This is the one place in the file where the narrative has to backtrack, and it is worth
noticing why. Everything up to `readInput` works to erase the difference between flag input
and JSON input; `readInput` returns a single flag-space object precisely so that nothing
downstream needs to know which mode it was. Then `cmdUpdate` branches on `source` anyway,
because the two modes genuinely mean different things — flag input appends, JSON input
replaces — and that difference cannot be normalised away.

The cost of the branch is that the JSON side calls neither `clearReplacedCollections` nor
`addMultiValueFields`, so a repeatable flag given alongside `--json` is silently dropped,
contradicting the comment in `readInput` that says flags still apply. `cmdCreate`, three
functions up, calls both writers and does not have the problem. See
`.issues/flag-multi-values-dropped-in-json-update.md`.

### Deleting, and the two-step protocol

JXA cannot read a tty, so `cx` cannot prompt. Confirmation is a protocol instead.

```bash
sed -n '35,43p' cx.js
```

```output
// The two-step --force protocol: print what would be destroyed, exit 5, and
// let the caller decide. Not an error, so it does not go through stderr.
function exitAwaitingConfirmation(format) {
	if (format !== "json") writeStdout("\nRe-run with --force to confirm.");
	$.exit(5);
}

// --- Contacts.app helpers ---

```

```bash
sed -n '1086,1119p' cx.js
```

```output
function cmdDelete(args) {
	const parsed = parseArgs(args, 1);
	if (parsed.positionals.length === 0) {
		exitWithError("usage: cx delete <id> [--force]", 1);
	}
	const format = outputFormat(parsed.flags);
	const app = getApp();
	const person = resolveId(app, parsed.positionals[0]);
	const flags = parsed.flags;
	const name = person.name() || "(no name)";
	const id = person.id();
	const sid = shortId(id);

	if (!flags.force) {
		const s = readSummary(person);
		emit(format, { action: "confirmation-required", target: s }, () => {
			const lines = [`Will delete: ${s.name} (${sid})`];
			if (s.email) lines.push(`  Email: ${s.email}`);
			if (s.phone) lines.push(`  Phone: ${s.phone}`);
			if (s.organization) lines.push(`  Org:   ${s.organization}`);
			return lines.join("\n");
		});
		exitAwaitingConfirmation(format);
	}

	app.delete(person);
	saveOrFail(app);
	// id is read before the delete: reading it after throws -1728, the object
	// is gone.
	emit(
		format,
		{ action: "deleted", id: id, shortId: sid, name: name },
		() => `Deleted ${name} (${sid})`,
	);
```

The first call prints what would be destroyed and exits **5**; the second, with `--force`,
does it. Note that the confirmation goes to *stdout* — it is not an error condition, it is
the first half of a two-call sequence, and a script can read it as JSON.

Note also where `name`, `id` and `sid` are captured: before `app.delete`. Reading a property
off a deleted JXA object throws `-1728`, so the values needed for the success message have
to be taken while the object still exists.

## Groups

`cmdGroups` is a second dispatch layer over six subcommands, each of which validates its own
argument count. The interesting one is membership.

```bash
sed -n '1175,1196p' cx.js
```

```output
function groupsAdd(app, contactId, groupName, format) {
	const person = resolveId(app, contactId);
	app.add(person, { to: resolveGroup(app, groupName) });
	saveOrFail(app);
	emit(
		format,
		{ action: "added", group: groupName, name: person.name() || "(no name)" },
		() => `Added ${person.name() || "(no name)"} to ${groupName}`,
	);
}

function groupsRemove(app, contactId, groupName, format) {
	const person = resolveId(app, contactId);
	app.remove(person, { from: resolveGroup(app, groupName) });
	saveOrFail(app);
	emit(
		format,
		{ action: "removed", group: groupName, name: person.name() || "(no name)" },
		() => `Removed ${person.name() || "(no name)"} from ${groupName}`,
	);
}

```

`app.add(person, {to: group})` is the required form. The obvious `group.people.push(person)`
throws JXA error `-1701` — one of those facts that is invisible from the code unless you
already know it, which is why it is written down in `CLAUDE.md` as well.

`groupsMembers` is a one-liner precisely because a group's `people` *is* an element
collection, so the fast plural reader applies to it.

## The selftest

Everything below the read/render boundary is a pure function of plain data, which means it
can be checked with no Contacts.app, no automation permission, and no contact touched.
`cx selftest` is that check, and it ships inside the production file because JXA has no
module system and there is nowhere else to put it.

```bash
sed -n '663,690p' cx.js
```

```output
// --- Selftest ---

// Everything below the read/render boundary is a pure function of plain data,
// so it can be checked without Contacts.app, without permission, and without
// touching a single contact. This is where the logic that actually goes wrong
// lives: label parsing, column fitting, date formatting, key aliasing.
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

```bash
./cx selftest
```

```output
selftest: ok
```

The checks are literal input against literal expected output — label parsing, `unwrapLabel`,
`padRight`/`fit`, date round-tripping, JSON key aliasing, `parseArgs`, and a full
`formatCard` render from a hand-built record. `task test` runs it *before* the integration
suite for exactly that reason: a logic regression fails in milliseconds rather than after
two minutes of Apple Events.

## Generated help

`usage()` builds its field sections from the catalogues rather than listing them, so the
help text cannot drift from what the parser accepts.

```bash
sed -n '613,632p' cx.js
```

```output
// The options sections are generated from the catalogues, so the help text
// cannot drift from the parser. It used to say "[opts]" and stop, leaving
// eight flags documented nowhere.
function usage() {
	const flagsOf = (table) => {
		const names = [];
		for (let i = 0; i < table.length; i++) {
			if (table[i].flag) names.push(table[i].flag);
		}
		return names;
	};
	const scalars = flagsOf(SCALARS);
	const multi = flagsOf(MULTI);

	return [
		"Usage: cx <command> [options]",
		"",
		"Commands:",
		"  list [--group <name>]                    List contacts",
		"  search <query>                           Search contacts",
```

The result is checked from the outside — `tests/test.sh` asserts that `--birthday`,
`--replace` and `--format json` all appear in the output of a bare `cx`.

```bash
./cx help | sed -n '19,32p'
```

```output
Contact fields:
  --first --last --middle --suffix --nickname --maiden --org --title --dept --birthday --note

Repeatable fields, as label:value — repeat for more than one:
  --email --phone --url --related --date
  Example: --email work:me@co.com --email home:me@home.com

Other options:
  --replace <field>     Empty a collection before adding: email, phone, url, related, date
  --note-append <text>  Append to the note instead of replacing it
  --group <name>        Add to a group on create, filter on list
  --json                Read contact JSON from stdin (create, update)
  --format json         Emit JSON instead of text
  --force               Confirm a destructive operation
```

## Testing

Two layers. `cx selftest` is pure and instant. `tests/test.sh` drives the real binary
against a real address book, creating contacts prefixed `CxTest_<pid>` and removing them in
an `EXIT` trap.

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

```bash
grep -c 'assert_' tests/test.sh
```

```output
75
```

Seventy-five assertions across twenty-two sections, and most of them are regressions with a
comment naming the defect they pin: the timezone bug, the orphaned half-contact, `--group`
vanishing in JSON mode, `cx delete --force <id>` reading the flag as the id, the note
reaching stdout. Read the comments in `tests/test.sh` and you have most of the bug history.

The one thing neither layer covers is CI: `.github/workflows/checks.yml` runs `task lint`
on Linux and nothing else, because the integration suite needs macOS, Contacts.app and a
granted automation permission. `cx selftest` needs none of those beyond macOS, and nothing
runs it there either.

## Exit codes are the API

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| 0    | success                                                             |
| 1    | error — bad flag, bad date, unknown command, save failed            |
| 2    | permission denied — Contacts automation not granted                 |
| 3    | not found — no contact or group matches                             |
| 4    | ambiguous id — a short id matched more than one contact             |
| 5    | confirmation required — re-run with `--force`                       |

The integration suite asserts on 1, 3, 4 and 5. Anything scripting `cx` depends on these, so
changing one is a breaking change.

## Performance, measured

Every design decision above that looks like premature optimisation was in fact a response to
a measurement. The numbers, at 343 contacts on an M4:

```bash
sed -n '/^| Command/,/^| groups delete/p' README.md
```

```output
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
```

Nothing above 1.3s, and roughly half of each figure is `osascript` startup — a floor no
change to `cx.js` can move. The two numbers that matter are the ones no longer in the table:
`list` took 47 seconds before plural property access, and everything resolving a short id
took about 10 seconds before the `_beginsWith` query. `task bench` regenerates the table.

## Where to look first

- **Adding a contact field** — one row in `SCALARS` or `MULTI`. Do not add a case to a
  consumer; if you want to, the row is missing a key.
- **Changing how a card looks** — `formatCard`, and nothing else. It is pure.
- **Changing what a list shows** — `readSummaries` *and* `readSummary`, which must stay in
  step, plus `formatTable`'s column list.
- **Anything touching a contact id** — go through `resolveId`.
- **Anything that can fail during a create** — hoist it above `app.people.push`.
- **Anything slow** — check whether you are calling a property per contact instead of per
  collection, and remember that plural access does not help on a `whose()` result.

## Index

| #   | Severity | Issue                                                    | Primary location                   |
| --- | -------- | -------------------------------------------------------- | ---------------------------------- |
| 1   | medium   | `nothing-verifies-the-walkthrough-so-it-shipped-stale`    | `.github/workflows/checks.yml:30-31`, `Taskfile.yml` |

**Total: 1 issue (0 critical, 0 high, 1 medium, 0 low)**

Findings from this pass live in `.issues/`, which is globally ignored and does not ship.
Related existing findings from the `code-theory` pass are referenced inline above:
`json-input-ignores-url-related-and-date-collections`,
`docs-claim-json-writes-addresses-and-social-profiles`,
`format-validated-after-mutation-in-create-and-update`,
`flag-multi-values-dropped-in-json-update`, and
`label-detection-uses-a-closed-scheme-list`.

