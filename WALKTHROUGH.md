# cx Walkthrough

*2026-09-14T20:35:38Z by Showboat 0.6.1*
<!-- showboat-id: 089f1964-7276-44b7-927f-16504d093370 -->

## Overview

`cx` is a command-line tool for Apple Contacts on macOS. It exists for one
reason: `CNContactStore` cannot read or write a contact's **note** without the
`com.apple.developer.contacts.notes` entitlement, which needs Apple's approval
and an app bundle. JXA — JavaScript for Automation, run through `osascript` —
has full access to every property with no entitlement and no signing.

That constraint shapes everything below. There are two files:

- `cx`, a short bash wrapper
- `cx.js`, the whole tool

JXA has no module system, so `cx.js` is one file by design. It is organised by
section banner, and the banners do real work — where a function sits tells you
what it is allowed to touch.

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

`--` matters: it separates `osascript`'s own arguments from the script's, and
without it `osascript` would try to interpret `--format` itself.

## Architecture: the boundary the design turns on

Six banners divide the file.

```bash
grep '^// --- ' cx.js
```

```output
// --- Process I/O: stdin, stdout, stderr, argv, exit ---
// --- Pure helpers ---
// --- Contacts access ---
// --- Commands and dispatch ---
// --- Selftest ---
// --- Run ---
```

The load-bearing one is **Contacts access**. Everything above it is plain
JavaScript over plain data — no Apple Events, no permission prompt, no
address book. Everything below it talks to Contacts.app.

So position answers a question you would otherwise have to read the body to
answer: *does this touch Contacts?* Keep it that way when adding a function.

Two consequences follow from that line, and they are the two ideas the rest of
this document keeps returning to:

- **The read/render boundary.** `read*` functions turn live Contacts objects
  into plain records. `format*` functions turn records into text and never
  touch a JXA object. That is what makes `--format json` a serialiser rather
  than a second renderer.
- **`cx selftest`** can exercise everything above the banner with no
  permission and no contacts — which is why the selftest now has a banner of
  its own, at the end, rather than sitting in the middle of the command bodies.

## Entry: dispatch

`main` is the last function in the file, and `main()` the last line. It reads
argv, pulls the command off the front, and switches.

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

`$.NSProcessInfo` gives every argument `osascript` itself received, so the
wrapper's own arguments are still in there. The slice after `--` is the user's.

## The catalogues

`SCALARS` and `MULTI` are the single definition of every contact field, in the
order a card renders them. The parser reads them, the flag allowlist is derived
from them, the writers walk them, the renderers walk them, and `cx help` is
generated from them.

**Adding a field is one row.** If you find yourself adding a case to a
consumer, the row is missing a key.

```bash
sed -n '/^const SCALARS = \[/,/^\];/p' cx.js
```

```output
const SCALARS = [
	{ prop: "name", display: "Name", search: true },
	{ flag: "first", prop: "firstName", display: "First", search: true },
	{ flag: "last", prop: "lastName", display: "Last", search: true },
	{ flag: "middle", prop: "middleName", display: "Middle" },
	// namePrefix throws -1700 on some contacts; the read stays guarded.
	{ prop: "namePrefix", display: "Prefix", guarded: true },
	{ flag: "suffix", prop: "suffix", json: "nameSuffix", display: "Suffix" },
	{ flag: "nickname", prop: "nickname", display: "Nickname" },
	{ flag: "maiden", prop: "maidenName", display: "Maiden" },
	{ flag: "org", prop: "organization", display: "Organization", search: true },
	{ flag: "title", prop: "jobTitle", display: "Job Title" },
	{ flag: "dept", prop: "department", display: "Department" },
	{ flag: "birthday", prop: "birthDate", display: "Birthday", type: "date" },
	// Handled by applyNote, not the generic setter — see there.
	{ flag: "note", prop: "note", manual: true, search: true },
];
```

Four keys carry decisions rather than data:

- **`guarded`** — `namePrefix` throws `-1700` on some contacts, so `readCard`
  wraps that one read in a try/catch.
- **`manual`** — the note is not written by the generic scalar setter; it has
  its own writer, because replacing a note is the one destructive act the tool
  performs.
- **`json`** — names a payload key where it differs from the Contacts property.
  Exactly one row needs it (`suffix` / `nameSuffix`). This is a `SCALARS`
  concept only.
- **`search`** — whether `cx search` looks at this field. More on that below;
  it is not derivable, which is why the row says so.

```bash
sed -n '/^const MULTI = \[/,/^\];/p' cx.js
```

```output
const MULTI = [
	{
		flag: "email",
		coll: "emails",
		ctor: "Email",
		defaultLabel: "home",
		display: "Email",
		search: true,
	},
	{
		flag: "phone",
		coll: "phones",
		ctor: "Phone",
		defaultLabel: "home",
		display: "Phone",
		search: true,
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

**`ctor` is the writable test.** It names the Contacts constructor, it is
present on every row `cx` can build, and it is absent only on
`instantMessages`, which Contacts holds and `cx` only renders. The writers
filter on it.

Do not invent a second key for that. An earlier version filtered on a `json`
key that only two rows happened to carry, and four writable collections were
silently dropped.

Addresses and social profiles are not in `MULTI` at all. Contacts models an
address as a record of street, city, state, zip and country rather than the
`label`/`value` pair every writable collection uses, so it needs a shape `cx`
does not have. `cx get` renders them; no input mode sets them, and a payload
naming one is rejected rather than quietly ignored.

## Input: argv and stdin become one record

Two dialects reach the tool — repeated flags, and a JSON payload on stdin —
and they normalise into one plain record before anything is written.

`parseArgs` comes first. It takes a per-command allowlist derived from the
catalogues, so a flag a command does not read is an error rather than a
silently ignored argument.

```bash
sed -n '/^function flagsOf/,/^}/p' cx.js
```

```output
function flagsOf(table) {
	const names = [];
	for (let i = 0; i < table.length; i++) {
		if (table[i].flag) names.push(table[i].flag);
	}
	return names;
}
```

```bash
sed -n '/^const KNOWN_FLAGS = {/,/^};/p' cx.js
```

```output
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

Note `group` is allowed on `list` and `create` but not on `update` — a
difference the change record below inherits.

`buildChange` is the heart of the input path. It is **pure**: plain data in,
plain data out, no Contacts object anywhere. That is what lets `cx selftest`
cover the entire flag-and-payload mapping.

```bash
sed -n '/^function buildChange/,/^}/p' cx.js
```

```output
function buildChange(flags, payload) {
	const change = {
		scalars: {},
		note: null,
		collections: {},
		// Only cmdCreate ever reads this. `update`'s allowlist rejects --group,
		// so it is unconditionally null on that path; the record is built the
		// same way for both rather than branching on the command.
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

The record it returns is **the change record**, and it is the file's central
noun — one normalised shape that both input dialects produce:

    { scalars: {firstName, birthDate: <Date>},
      note: {mode, text} | null,
      collections: {emails: {mode, items}},
      group, format }

Two things about it are load-bearing.

**Every rejection belongs here**, before `getApp()` is ever called. A command
rejected for bad input has opened nothing and written nothing.

**Input is closed.** An unknown flag, an unknown payload key, and an update
naming no field are all errors. So exit 0 from a write means something actually
changed. Do not loosen that to accept-and-ignore: the field this tool exists
for has no undo, and a silent no-op reported as success is the worst available
outcome.

One name to keep straight: inside `applyCollections` the per-collection
`{mode, items}` pair is called `entry`, not `change`. `change` means the whole
record everywhere in the file, and reusing it for one sixth of one field of
itself made that function the one place the vocabulary quietly shifted.

JSON arrives through `applyPayload`, which writes into the same record.

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

The two dialects differ in one deliberate way: **flag input appends, JSON input
replaces.** `--replace <field>` empties a collection first, which is also how
you clear one. Where both name the same collection the payload's replace wins
and both sets of values land in it.

That asymmetry is not an accident waiting to be tidied up. The key spaces were
merged; these two semantics were not, and unifying them breaks one of two
workflows.

## Crossing into Contacts

Everything so far touched no address book. `getApp` is the crossing.

```bash
sed -n '/^function getApp/,/^}/p' cx.js
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
```

`app.name()` is a cheap probe whose only purpose is to make the permission
failure happen here, with a message that says what to do, rather than somewhere
deeper with a raw error number.

Resolving an id is the other common crossing.

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

A short id is the first 8 characters of the UUID, before the `:ABPerson`
suffix. One `whose({id: {_beginsWith}})` query resolves either form, and it is
case-insensitive. A prefix that matches more than one contact exits 4 — so an
automated caller should pass the full id, because exit 4 is not something a
script can retry out of.

## Reading: one Apple Event, not one per contact

This is the performance story, and it is the whole performance story.

`person.id()` is one Apple Event. A loop over 340 contacts calling `.id()` on
each is 340 events, and that is how `cx list` once took 47 seconds. But
`app.people.id()` — plural access on the *collection* — fetches every id in a
single event.

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
		summaries.push(
			summaryRecord(ids[i], names[i], orgs[i], emails[i], phones[i]),
		);
	}
	return summaries;
}
```

Five properties, five events, paired by index. The length check is not
paranoia: the arrays arrive from separate events, so if Contacts ever returned
different lengths, pairing them by position would attach one person's email to
another. Refusing is the only safe answer.

**Plural access works on an element collection — `app.people`, or a group's
people — and not on a `whose()` specifier**, where it measured 13.3s for 256
names, worse than the per-contact loop.

`readSummary` is the one-contact version, and it survives for exactly one
caller: `cmdDelete`, which describes a single already-resolved contact in its
confirmation preview. Fetching the whole book plurally to do that would be
absurd.

```bash
sed -n '/^function readSummary(/,/^}/p' cx.js
```

```output
function readSummary(person) {
	const emails = person.emails();
	const phones = person.phones();
	return summaryRecord(
		person.id(),
		person.name(),
		person.organization(),
		emails.length > 0 ? [emails[0].value()] : [],
		phones.length > 0 ? [phones[0].value()] : [],
	);
}
```

Both readers, and the search reader below, build their record through one
function — so the three rules that shape it cannot drift apart.

```bash
sed -n '/^function summaryRecord/,/^}/p' cx.js
```

```output
function summaryRecord(id, name, org, emailValues, phoneValues) {
	return {
		id: id,
		shortId: shortId(id),
		name: name || "(no name)",
		email: emailValues && emailValues.length > 0 ? emailValues[0] : "",
		phone: phoneValues && phoneValues.length > 0 ? phoneValues[0] : "",
		organization: org || "",
	};
}
```

## Search: what Contacts cannot be asked

`cx search` used to be one `whose()` disjunction over `firstName`, `lastName`,
`name` and `organization`, followed by a `readSummary` per hit. Both halves
were wrong, and they were wrong for the same underlying reason.

**Contacts cannot express a predicate over an element collection.** This is
measured, not inferred:

    whose({note:   {_contains: q}})            works, 232ms
    whose({emails: {value: {_contains: q}}})   throws
        "Object does not have property emails"

So for as long as the match happened inside Contacts, emails and phones were
unreachable at any price. The note was reachable and simply was not asked for.
The effect was that `cx search jane@co.com` printed `(no contacts)` and exited
0 — indistinguishable from "this person is not in your address book" — in a
tool whose whole reason to exist is the note field.

The second half was cost. Every hit was a separate `readSummary`, so a broad
query paid one Apple Event per property per contact. `cx search a` matched 267
of 340 contacts and took **55 seconds**.

What dissolves both: the collections are not *queryable*, but they are
*readable in bulk*. `app.people.emails.value()` returns all 340 nested arrays
in one Apple Event, in 128ms. So the fetch moved to plural access and the match
moved into JavaScript.

```bash
sed -n '/^function readSearchables/,/^}/p' cx.js
```

```output
function readSearchables(collection) {
	// name, organization, emails and phones are wanted by both the table and
	// the match set. Memoise so the overlap costs one Apple Event, not two.
	const columns = {};
	const fetch = (key, get) => {
		if (!columns[key]) columns[key] = get();
		return columns[key];
	};

	const ids = fetch("id", () => collection.id());

	const scalarRows = searchRows(SCALARS);
	for (let i = 0; i < scalarRows.length; i++) {
		const prop = scalarRows[i].prop;
		fetch(prop, () => collection[prop]());
	}
	const multiRows = searchRows(MULTI);
	for (let k = 0; k < multiRows.length; k++) {
		const coll = multiRows[k].coll;
		fetch(coll, () => collection[coll].value());
	}

	// The five the table renders, searchable or not.
	const names = fetch("name", () => collection.name());
	const orgs = fetch("organization", () => collection.organization());
	const emails = fetch("emails", () => collection.emails.value());
	const phones = fetch("phones", () => collection.phones.value());

	// Separate events paired by index, as in readSummaries. With eight the
	// window in which Contacts could change under us is wider, so name the
	// property that disagreed rather than reporting a bare mismatch.
	const keys = Object.keys(columns);
	for (let c = 0; c < keys.length; c++) {
		if (columns[keys[c]].length !== ids.length) {
			exitWithError(
				`Contacts returned ${columns[keys[c]].length} values for ${keys[c]} and ${ids.length} ids`,
				1,
			);
		}
	}

	const records = [];
	for (let i = 0; i < ids.length; i++) {
		const haystack = [];
		for (let x = 0; x < scalarRows.length; x++) {
			haystack.push(columns[scalarRows[x].prop][i]);
		}
		for (let k = 0; k < multiRows.length; k++) {
			const spec = multiRows[k];
			const values = columns[spec.coll][i];
			for (let v = 0; v < values.length; v++) {
				// The catalogue's date test, same as readCard's. customDates is
				// the one collection whose .value() yields Date objects, so
				// routing through it now keeps "adding a field is one row" true
				// if that row is ever marked searchable.
				const raw = values[v];
				haystack.push(raw && spec.type === "date" ? formatDate(raw) : raw);
			}
		}
		records.push({
			// Values only, never labels: `cx search work` must not return every
			// contact that happens to have a work email.
			summary: summaryRecord(ids[i], names[i], orgs[i], emails[i], phones[i]),
			haystack: haystack,
		});
	}
	return records;
}
```

Three details in there are decisions rather than mechanics.

**The memoised `fetch`.** `name`, `organization`, `emails` and `phones` are
wanted by both the rendered table and the match set. Without memoising, the
overlap would cost a second Apple Event each.

**Values only, never labels.** The haystack holds what a person typed as a
value, not the label it was filed under. Otherwise `cx search work` would
return every contact with a work email.

**The catalogue's date test, not the value's shape.** `customDates` is the one
collection whose `.value()` yields `Date` objects. Routing every collection
value through `spec.type === "date"` now is what keeps "adding a field is one
row" true if that row is ever marked searchable.

The match itself is pure, and above the Contacts banner.

```bash
sed -n '/^function matchesQuery/,/^}/p' cx.js
```

```output
function matchesQuery(record, query) {
	const needle = String(query).toLowerCase();
	for (let i = 0; i < record.haystack.length; i++) {
		const value = record.haystack[i];
		if (value && value.toLowerCase().indexOf(needle) !== -1) return true;
	}
	return false;
}
```

Lowercase-and-`indexOf` reproduces `whose({_contains})` exactly. That matters
more than it looks: `_contains` is **case-insensitive but diacritic-sensitive**
— `MARK` finds Mark, and `Calderon` does *not* find `Calderón`. Both were
measured and both are pinned in the selftest, so this rewrite changed *which
fields* are searched and nothing about *how* a string is compared.

The falsy guard is the whole empty-and-null story in one clause: a null note
(298 of 340 contacts here), an empty organization and an absent value all fall
through without a branch of their own.

`filterSearch` then hands back the summary and drops the haystack, so the
search key cannot reach stdout and `--format json` emits the six keys it always
did.

```bash
sed -n '/^function filterSearch/,/^}/p' cx.js
```

```output
function filterSearch(records, query) {
	const hits = [];
	for (let i = 0; i < records.length; i++) {
		if (matchesQuery(records[i], query)) hits.push(records[i].summary);
	}
	return hits;
}
```

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
	// Only the first positional is read. Multi-term AND matching is the
	// mitigation if `cx search gmail` proves too noisy now that email domains
	// are matched -- parseArgs already collects the rest.
	const query = parsed.positionals[0];

	// This used to be one whose() disjunction over four name/organization
	// properties, then a readSummary per hit. Both halves were problems: emails,
	// phones and the note could not be reached by any specifier Contacts
	// accepts, and `cx search a` matched 267 of 340 contacts at one Apple Event
	// per property per hit -- measured at 55 seconds.
	//
	// Fetching plurally and matching here costs the same whether the query hits
	// nothing or everything. It is constant in the number of matches and linear
	// in the size of the address book, where it used to be the other way round.
	const app = getApp();
	printSummaries(filterSearch(readSearchables(app.people), query), format);
}
```

The result is a cost that no longer depends on how much you find:

    cx search Ayers      2 hits     1.07s -> 1.19s
    cx search zzznosuch  0 hits     0.54s -> 1.25s
    cx search a        286 hits    55.51s -> 1.20s

Search is now **constant in the number of matches and linear in the size of the
address book.** It used to be the other way round. A narrow query pays about a
third of a second more than it did; everything else is the trade.

The match set is catalogue-driven, read by one function.

```bash
sed -n '/^function searchRows/,/^}/p' cx.js
```

```output
function searchRows(table) {
	const rows = [];
	for (let i = 0; i < table.length; i++) {
		if (table[i].search) rows.push(table[i]);
	}
	return rows;
}
```

It is deliberately **not** derived from `ctor`, tempting though that is, and
the scalar side is where that would be fatal rather than merely wrong:
`app.people.namePrefix()` throws `-1728` for the **whole array**, not per
contact. `readCard`'s `guarded` try/catch works because it wraps one call for
one person; a plural fetch has no equivalent. A `guarded` row marked searchable
would kill `cx search` for every query, for everyone — so the selftest asserts
it never happens.

## Rendering: one record, two formats

Nothing below this line touches a JXA object. `emit` is the single place that
decides between serialising and rendering.

```bash
sed -n '/^function emit(/,/^}/p' cx.js
```

```output
function emit(format, data, renderText) {
	writeStdout(format === "json" ? JSON.stringify(data, null, 2) : renderText());
}
```

```bash
sed -n '/^function formatTable/,/^}/p' cx.js
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
		for (let c = 0; c < columns.length - 1; c++) {
			line += fit(values[c], columns[c].width);
		}
		return line + values[columns.length - 1];
	};

	const lines = [];
	const header = row(columns.map((col) => col.header));
	lines.push(header);
	lines.push("-".repeat(header.length));

	for (let i = 0; i < summaries.length; i++) {
		const s = summaries[i];
		lines.push(row(columns.map((col) => s[col.key] || "")));
	}
	return lines.join("\n");
}
```

Column widths follow the data rather than being fixed, and `fit` truncates with
one space kept as a gutter so adjacent columns never run together.

```bash
sed -n '/^function fit(/,/^}/p' cx.js
```

```output
function fit(str, len) {
	return str.length >= len ? `${str.substring(0, len - 1)} ` : str.padEnd(len);
}
```

The padding is `String.prototype.padEnd` — there used to be a hand-rolled
`padRight` here, which is the same function including the no-truncate rule.
`fit`'s own rule is the part that is `cx`'s decision rather than the language's,
which is why the selftest pins `fit` and no longer pins the padding.

`--format json` emits the same records the text formatters consume, which is
what makes it a serialiser rather than a second renderer. It is an **output**
format only: `cx get --format json` emits the nested read shape, not the flat
shape `--json` accepts, and piping one into the other is an error naming the
mismatch rather than a command that exits 0 having changed nothing.

## Dates: the one that bites

Contacts stores a birthday as a date-only value at **noon local time**.
`new Date("1990-05-14")` parses as UTC midnight, which is the previous day
anywhere west of Greenwich. Every date goes through one parser and one
formatter, and neither is optional.

```bash
sed -n '/^function parseDateFlag/,/^}/p' cx.js
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
```

```bash
sed -n '/^function formatDate/,/^}/p' cx.js
```

```output
function formatDate(date) {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
```

`source` names the input in the error — `--birthday` for a flag, `customDates`
for a payload key — so the message points at what the user actually typed.

## `label:value` and the one ambiguous grammar

Every repeatable flag takes `label:value`, and the value may itself contain a
colon. That is the only ambiguous piece of grammar `cx` has.

```bash
sed -n '/^const SLASHLESS_SCHEMES/,/^}/p' cx.js
```

```output
const SLASHLESS_SCHEMES = ["tel", "mailto"];

function parseLabelValue(str, defaultLabel) {
	const colonIdx = str.indexOf(":");
	if (colonIdx > 0 && colonIdx < str.length - 1) {
		const beforeColon = str.substring(0, colonIdx);
		const looksLikeScheme =
			/^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(beforeColon) &&
			str.substr(colonIdx + 1, 2) === "//";
		if (looksLikeScheme || SLASHLESS_SCHEMES.indexOf(beforeColon) !== -1) {
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

The rule being reached for is *a colon that starts a URI scheme is not a label
separator*. That used to be an allowlist of four schemes, which meant
`--url ssh://host` stored `//host` under a label named `ssh` — silently, and
the same for `ftp:`, `sip:`, `xmpp:`, `file:` and every app scheme.

A scheme followed by `//` is now decided by shape. The named pair survives only
for `tel:` and `mailto:`, where shape alone cannot tell a scheme from a label,
and that is what the allowlist was genuinely load-bearing for.

Contacts labels come back wrapped as `_$!<Mobile>!$_`; one helper strips that.

```bash
sed -n '/^function unwrapLabel/,/^}/p' cx.js
```

```output
function unwrapLabel(label) {
	const m = /^_\$!<(.*)>!\$_$/.exec(label);
	return m ? m[1] : label;
}
```

## Writing

Three writers consume the change record, and nothing else writes.

```bash
sed -n '/^function applyScalars/,/^}/p' cx.js
```

```output
function applyScalars(person, scalars) {
	const props = Object.keys(scalars);
	for (let i = 0; i < props.length; i++) {
		person[props[i]] = scalars[props[i]];
	}
}
```

```bash
sed -n '/^function applyCollections/,/^}/p' cx.js
```

```output
function applyCollections(app, person, collections) {
	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		// `entry`, not `change`: everywhere else in the file `change` is the
		// whole record buildChange returns. Here it is one {mode, items} pair
		// for one collection, and reusing the name makes a reader arriving from
		// cmdUpdate re-derive which is which.
		const entry = collections[spec.coll];
		if (!spec.ctor || !entry) continue;
		if (entry.mode === "replace") clearCollection(app, person, spec);
		for (let j = 0; j < entry.items.length; j++) {
			person[spec.coll].push(
				app[spec.ctor]({
					label: entry.items[j].label,
					value: entry.items[j].value,
				}),
			);
		}
	}
}
```

One writer for every collection, filtering on `ctor`. There used to be four
writers over two disjoint key spaces, and which ones ran depended on a `source`
flag carried down from the parser.

The note has its own writer, because it is the one field with no undo.

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

Replacing a non-empty note echoes the previous text to stderr, so it survives
in scrollback. `--note` and `--note-append` are contradictory, so giving both
is an error rather than a silent win for one of them.

## The invariant after the push

Every mutation ends in `saveOrFail`.

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

What `save` actually does was measured rather than assumed, because the repo
had documented both answers at different times:

**A mutation goes live in the running Contacts.app as it is made; `save`
persists it to disk.** Push a person without saving and a *separate process*
finds it. Quit Contacts.app and it is gone.

That has a sharp consequence. A failure between `app.people.push` and
`saveOrFail` strands a real, findable, half-built contact for the life of the
Contacts process. So **nothing that can fail may run after the push.** All
validation lives in `buildChange`, and the three writers contain no
`exitWithError` between them. Keep it that way.

Worth knowing alongside it: **Contacts validates nothing.**
`--email "work:))))"` is accepted and stored. `cx` type-checks its input and
value-checks exactly one thing, dates. A write that succeeded was inspected by
nobody else.

## The write commands

`cmdCreate` and `cmdUpdate` are both thin over the record.

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

Group membership is the one place the obvious call is wrong:
`app.add(person, {to: group})` works, and `group.people.push()` throws `-1701`.

## Delete: read before you delete

Reading a deleted object throws `-1728`, so whatever the confirmation needs has
to be captured first.

```bash
sed -n '/^function cmdDelete/,/^}/p' cx.js
```

```output
function cmdDelete(args) {
	const parsed = parseArgs(args, 1, KNOWN_FLAGS.delete);
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
}
```

Destructive commands print what they would do and exit 5; `--force` proceeds.

## Selftest: what it can reach, and why

`cx selftest` has a banner of its own at the end of the file. That is new. It
used to sit between `readInput` and the first command body, so walking the file
in execution order meant stepping over roughly 390 lines of fixture —
`readInput` hands its record to `cmdCreate`, and `cmdCreate` was 200 lines
further down. Every other transition in this file reads as a call; that one was
a jump the reader had to take on trust.

Its position now matches what it is. Its reach is exactly the set of functions
above the Contacts banner, which is the same line this whole document has been
organised around, and it touches nothing: no permission, no contacts,
milliseconds.

What it covers is the logic that actually goes wrong — label parsing, column
fitting, date handling, the whole flag-and-payload mapping, and now the search
matcher. The checks that earn their place assert `cx`'s own decisions rather
than the language's: `fit`'s gutter rule, the diacritic behaviour inherited
from `whose({_contains})`, and the invariant that no `guarded` field is ever
searchable.

```bash
sed -n '/no guarded field is searchable/,/);/p' cx.js
```

```output
		"no guarded field is searchable",
		searchRows(SCALARS)
			.filter((spec) => spec.guarded)
			.map((spec) => spec.prop),
		[],
	);
```

## Exit codes

The exit-code set is the API. Changing which input produces which code is a
breaking change.

    0  success
    1  error
    2  permission denied
    3  not found
    4  ambiguous ID
    5  confirmation required

Destructive commands print what they would do and exit 5; re-run with
`--force`.

## Where to look first

| If you are changing… | Start at |
| --- | --- |
| a contact field | one row in `SCALARS` or `MULTI`. If you are adding a case to a consumer, the row is missing a key. |
| how input is accepted or rejected | `buildChange`, and `KNOWN_FLAGS` for the flag names. Nothing below the Contacts banner should need to know. |
| what `cx search` matches | the `search` key on a catalogue row — and read `searchRows`' comment first, because a `guarded` row there breaks every query for everyone. |
| how anything renders | the `format*` functions. If you reach for a JXA object there, the record is missing a field. |
| performance | plural access, and whether the call is on an element collection rather than a `whose()` specifier. For search the cost is the fetch, not the match. |
| anything that writes | `buildChange` for the validation, and remember that nothing which can fail may run after `app.people.push`. |

## Loose ends

Two things the code names as deliberately out of scope, both in search:

- `cx search 5550199` does not find `555-0199`. Not a regression — it found
  nothing at all before — but it is the most likely first complaint now that
  phones are nominally searchable.
- Only the first positional is read. Multi-term AND matching is the mitigation
  if matching email domains proves too noisy, and `parseArgs` already collects
  the rest.

