ObjC.import("Foundation");
ObjC.import("stdlib");

// --- Process I/O: stdin, stdout, stderr, argv, exit ---

// JXA has no console: a line reaches a pipe only through an NSFileHandle.
// The two writers differ by handle and nothing else, so the encoding dance
// lives here once. Both stay function declarations -- the file relies on
// hoisting throughout, and const arrow bindings do not hoist.
function writeTo(handle, msg) {
	const str = $.NSString.alloc.initWithUTF8String(`${msg}\n`);
	handle.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
}

function writeStderr(msg) {
	writeTo($.NSFileHandle.fileHandleWithStandardError, msg);
}

function writeStdout(msg) {
	writeTo($.NSFileHandle.fileHandleWithStandardOutput, msg);
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

function exitWithError(message, code) {
	writeStderr(`error: ${message}`);
	$.exit(code || 1);
}

// The two-step --force protocol: print what would be destroyed, exit 5, and
// let the caller decide. Not an error, so it does not go through stderr.
function exitAwaitingConfirmation(format) {
	if (format !== "json") writeStdout("\nRe-run with --force to confirm.");
	$.exit(5);
}

function emit(format, data, renderText) {
	writeStdout(format === "json" ? JSON.stringify(data, null, 2) : renderText());
}

// Every list of contacts is sorted by display name before rendering.
function printSummaries(summaries, format) {
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	emit(format, summaries, () => formatTable(summaries));
}

// --- Pure helpers ---
//
// Plain data in, plain data out. Nothing below here until the next banner
// touches Contacts.app, which is what makes `cx selftest` able to cover it
// with no permission and no address book. That is the file's one structural
// line, so the sections draw it rather than grouping by topic.

function isPermissionError(e) {
	if (e.errorNumber === -1743 || e.errorNumber === -10004) return true;
	return /not authori[sz]ed|not permitted|-1743/i.test(String(e.message || ""));
}

function shortId(fullId) {
	return String(fullId).substring(0, 8);
}

// source names the input in the error -- "--birthday" for a flag, "customDates"
// for a payload key -- so the message points at what the user actually typed.
// Contacts stores a birthday as a date-only value at noon local time. Parsing
// "1990-05-14" with new Date() gives UTC midnight, which is the previous day
// in any negative UTC offset, and Contacts then records May 13. Building from
// local components at noon avoids that, and avoids the timezones that skip
// midnight entirely on a DST transition.
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

// Contacts wraps its built-in labels as _$!<Mobile>!$_. A label the user
// typed passes through unchanged.
function unwrapLabel(label) {
	const m = /^_\$!<(.*)>!\$_$/.exec(label);
	return m ? m[1] : label;
}

// Pads to a column width, or truncates to it keeping one space as a gutter.
// Character counts assume one column per UTF-16 unit, so CJK and emoji names
// misalign; that is accepted for a personal tool rather than fixed.
function fit(str, len) {
	return str.length >= len ? `${str.substring(0, len - 1)} ` : str.padEnd(len);
}

// The summary record every list-shaped command renders, and the one place its
// three rules live: an unnamed contact reads "(no name)", a collection
// contributes only its first value, and a missing scalar is "" rather than
// null. readSummary, readSummaries and readSearchables all go through it, so
// the rules cannot drift between the one-contact and bulk paths.
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

// Contacts' whose({_contains}) is case-insensitive and diacritic-sensitive:
// "MARK" and "mark" both find Mark, and "Calderon" does not find "Calderón".
// Lowercasing reproduces both, so moving the match into JavaScript changes
// which fields are searched and nothing about how a string is compared.
//
// The falsy guard is the whole empty/null story: a null note (298 of 340
// contacts here), an "" organization and an absent value all fall through
// without a branch of their own.
function matchesQuery(record, query) {
	const needle = String(query).toLowerCase();
	for (let i = 0; i < record.haystack.length; i++) {
		const value = record.haystack[i];
		if (value && value.toLowerCase().indexOf(needle) !== -1) return true;
	}
	return false;
}

// Hands back the summary and drops the haystack, so the search key cannot
// reach stdout and --format json emits the six keys it always did.
function filterSearch(records, query) {
	const hits = [];
	for (let i = 0; i < records.length; i++) {
		if (matchesQuery(records[i], query)) hits.push(records[i].summary);
	}
	return hits;
}

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

function formatCard(record) {
	const lines = [];

	lines.push(`ID:           ${shortId(record.id)} (${record.id})`);

	for (let i = 0; i < SCALARS.length; i++) {
		const spec = SCALARS[i];
		if (!spec.display) continue;
		const value = record.fields[spec.prop];
		if (value) lines.push(`${spec.display}:`.padEnd(14) + value);
	}

	for (let k = 0; k < MULTI.length; k++) {
		const items = record.multi[MULTI[k].coll];
		for (let m = 0; m < items.length; m++) {
			lines.push(`${items[m].label}:`.padEnd(14) + items[m].value);
		}
	}

	const extras = record.addresses.concat(record.socialProfiles);
	for (let e = 0; e < extras.length; e++) {
		lines.push(`${extras[e].label}:`.padEnd(14) + extras[e].value);
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

// Every repeatable flag takes label:value, and the value may itself contain a
// colon, so this is the only ambiguous piece of grammar cx has. The rule it is
// reaching for is "a colon that starts a URI scheme is not a label separator".
//
// A scheme followed by // is decided by shape, because the alternative is a
// list of the schemes someone happened to need: --url ssh://host used to store
// //host under a label named ssh, and so did ftp:, sip:, xmpp:, file: and every
// app scheme. The named pair stays for the two that carry no slashes, where
// shape alone cannot tell mailto:a@b.com from a label called mailto.
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

const VERSION = "2.0.0";

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
		"  search <query>                           Search name, org, email, phone, note",
		"  get <id>                                 Show contact details",
		"  create (--first|--last|--org) ... [opts] Create contact",
		"  update <id> [opts]                       Update contact",
		"  delete <id> [--force]                    Delete contact",
		"  groups list                              List groups",
		"  groups members <name>                    List group members",
		"  groups add <id> <group>                  Add contact to group",
		"  groups remove <id> <group>               Remove contact from group",
		"  groups create <name>                     Create group",
		"  groups delete <name> [--force]           Delete group",
		"  selftest                                 Check the pure helpers",
		"  --version                                Print the version",
		"",
		"Contact fields:",
		`  ${scalars.map((f) => `--${f}`).join(" ")}`,
		"",
		"Repeatable fields, as label:value — repeat for more than one:",
		`  ${multi.map((f) => `--${f}`).join(" ")}`,
		"  Example: --email work:me@co.com --email home:me@home.com",
		"",
		"Other options:",
		`  --replace <field>     Empty a collection before adding: ${multi.join(", ")}`,
		"  --note-append <text>  Append to the note instead of replacing it",
		"  --group <name>        Add to a group on create, filter on list",
		"  --json                Read contact JSON from stdin (create, update)",
		"  --format json         Emit JSON instead of text",
		"  --force               Confirm a destructive operation",
	].join("\n");
}

// One row per single-valued field, in card order. flag is absent where cx can
// render the field but not set it; display is absent where the field is
// rendered somewhere other than the label column. json names the payload key
// where it differs from the Contacts property name -- a SCALARS concept only;
// a collection's payload key is always its coll.
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

// One row per repeatable field, read by the parser, the writer and the
// renderer. Adding a field is one row; before this it was four edits in four
// places, and missing one gave a field that parsed but never rendered. ctor is
// the writable test: it is present on every row cx can construct and absent
// only on instantMessages, which Contacts holds and cx only renders. Order
// here is the order they appear on a card.
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

function multiSpecForFlag(flag) {
	for (let i = 0; i < MULTI.length; i++) {
		if (MULTI[i].flag === flag) return MULTI[i];
	}
	return null;
}

// --replace names a collection. The flags are singular and the payload keys
// are plural, and the README teaches the plural, so accept either rather than
// rejecting the spelling the docs taught.
function multiSpecForReplace(name) {
	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		if (spec.ctor && (spec.flag === name || spec.coll === name)) return spec;
	}
	return null;
}

function scalarSpecForPayloadKey(key) {
	for (let i = 0; i < SCALARS.length; i++) {
		const spec = SCALARS[i];
		if (!spec.flag || spec.manual) continue;
		if (key === spec.prop || key === spec.json) return spec;
	}
	return null;
}

function multiSpecForPayloadKey(key) {
	for (let i = 0; i < MULTI.length; i++) {
		if (MULTI[i].ctor && key === MULTI[i].coll) return MULTI[i];
	}
	return null;
}

// The rows cx search looks at. A row carries search:true when its value is text
// someone would plausibly type, AND when Contacts answers a plural fetch for
// it. Both are required and neither is derivable, so the row says so rather
// than a consumer inferring it.
//
// Not derived from ctor, tempting as that is. The two facts line up today by
// coincidence: instantMessages has no ctor and no bulk .value(), but its
// .userName() fetches fine, and addresses fetch via .formattedAddress(). On the
// scalar side the stakes are higher -- app.people.namePrefix() throws -1728 for
// the WHOLE array, not per contact, so readCard's guarded try/catch has no
// plural equivalent and any rule that swept guarded rows in would kill search
// outright. cmdSelftest asserts that it never happens.
//
// Each row is one more Apple Event: ~0.13s at 340 contacts.
function searchRows(table) {
	const rows = [];
	for (let i = 0; i < table.length; i++) {
		if (table[i].search) rows.push(table[i]);
	}
	return rows;
}

function flagsOf(table) {
	const names = [];
	for (let i = 0; i < table.length; i++) {
		if (table[i].flag) names.push(table[i].flag);
	}
	return names;
}

// Every flag each command honours, derived from the catalogues so it cannot
// drift from them. A flag a command does not read is an error rather than a
// silent no-op: `cx update <id> --nte "text"` used to print "Updated <name>"
// and exit 0 having written nothing, which for the one field with no undo is
// the worst available outcome.
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

// Payload keys cx renders but cannot write. Mostly Contacts properties, plus
// `shortId`, which is cx's own derived field rather than one of theirs -- a
// caller may well pipe a summary record back in, so it belongs in the list
// even though nothing in Contacts is called that. Naming them beats dropping
// them: the README told users to pipe addresses and social profiles, which no
// writer has ever read.
const READ_ONLY_KEYS = [
	"id",
	"shortId",
	"name",
	"namePrefix",
	"groups",
	"addresses",
	"socialProfiles",
	"instantMessages",
];

// Returns the flags and the leftover positional arguments, so no command has
// to reach into args by index and a flag may appear anywhere. Before this,
// `cx delete --force <id>` treated --force as the contact ID and reported a
// missing contact.
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

// argv and the stdin payload become one plain record, and every rejection
// happens here -- before getApp(), before app.people.push. Nothing that can
// fail may run after the push, or a partly-built contact is left in the store
// with no save to complete it; an unsaved push is visible to every other
// process until Contacts.app quits, so the orphan is real.
//
// Being pure is the other half. The whole flag-and-payload mapping is now
// reachable from `cx selftest` with no Contacts permission and no address
// book, which is what the read/render boundary already gave the read side.
//
// The two dialects keep their own semantics deliberately: a repeated flag
// appends, a payload names a collection wholesale and so replaces it. Only the
// key spaces are merged -- everything is keyed by the Contacts property name.
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

function payloadItems(key, spec, value, existing) {
	if (!Array.isArray(value)) {
		exitWithError(`${key} must be an array of {label, value} objects`, 1);
	}
	const items = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			exitWithError(`${key}[${i}] must be a {label, value} object`, 1);
		}
		if (typeof item.value !== "string") {
			exitWithError(`${key}[${i}].value must be a string`, 1);
		}
		if (item.label !== undefined && typeof item.label !== "string") {
			exitWithError(`${key}[${i}].label must be a string`, 1);
		}
		items.push({
			label: item.label || spec.defaultLabel,
			value: spec.type === "date" ? parseDateFlag(item.value, key) : item.value,
		});
	}
	// The payload replaces the collection, so anything a repeated flag already
	// put there goes in behind it rather than being dropped on the floor.
	if (existing) {
		for (let j = 0; j < existing.items.length; j++) {
			items.push(existing.items[j]);
		}
	}
	return items;
}

// --- Contacts access ---
//
// Every function below talks to Contacts.app. read* return plain records and
// apply*/clear* take them, so the boundary above is crossed in exactly one
// direction: records out of read*, records into apply*.

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

// Every mutation ends in a save, and a failed save loses the whole change.
// Report that as such rather than as a raw JXA error.
function saveOrFail(app) {
	try {
		app.save();
	} catch (e) {
		exitWithError(`changes may not have been saved: ${e.message}`, 1);
	}
}

function findGroup(app, name) {
	const groups = app.groups.whose({ name: name })();
	return groups.length > 0 ? groups[0] : null;
}

function resolveGroup(app, name) {
	const group = findGroup(app, name);
	if (!group) exitWithError(`group not found: ${name}`, 3);
	return group;
}

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

// One already-resolved person, at one Apple Event per property. Still the right
// shape for cmdDelete's confirmation preview, where fetching the whole book
// plurally to describe a single contact would be absurd.
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

// One Apple Event per property for a whole collection, instead of one per
// contact per property. Measured at 341 contacts: five plural calls total
// ~0.7s, against ~48s for the equivalent per-contact loop.
//
// Only valid on an element collection — app.people, or a group's people. Not
// on a whose() specifier, where plural access measured 13.3s for 256 names,
// worse than the per-contact loop.
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

// Everything cx search matches on, fetched plurally, paired by index, and
// handed over as plain data.
//
// Contacts cannot express a predicate over an element collection --
// whose({emails: {value: {_contains: q}}}) throws "Object does not have
// property emails" -- so for as long as the match happened server-side, emails,
// phones and the note were unreachable. They fetch in bulk perfectly well
// (emails 128ms, phones 133ms for 340 contacts), which is why the match moved
// here: not queryable, but readable.
//
// Strictly more expensive than readSummaries -- eight events against five,
// 1.15s against 0.79s -- so cmdList keeps the cheaper one rather than both
// sharing this and paying for three properties no table renders.
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
			const raw = items[m].value();
			list.push({
				label: unwrapLabel(items[m].label() || spec.display),
				// The same test the scalar loop above uses. customDates is the one
				// collection whose values are Date objects, and its row says so --
				// reading the value to find out let the read and write paths
				// disagree about what a date field is.
				value: raw && spec.type === "date" ? formatDate(raw) : raw,
			});
		}
		multi[spec.coll] = list;
	}

	const addresses = [];
	const rawAddresses = person.addresses();
	for (let a = 0; a < rawAddresses.length; a++) {
		addresses.push({
			label: unwrapLabel(rawAddresses[a].label() || "Address"),
			value: (rawAddresses[a].formattedAddress() || "").replace(/\n/g, ", "),
		});
	}

	const socialProfiles = [];
	const rawSocial = person.socialProfiles();
	for (let sp = 0; sp < rawSocial.length; sp++) {
		socialProfiles.push({
			label: rawSocial[sp].serviceName() || "Social",
			value: rawSocial[sp].userName() || rawSocial[sp].url() || "",
		});
	}

	return {
		id: person.id(),
		fields: fields,
		multi: multi,
		addresses: addresses,
		socialProfiles: socialProfiles,
		groups: person.groups().map((g) => g.name()),
	};
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

// The note is the field cx exists to reach — it is the whole reason for
// choosing JXA over CNContactStore — and the one no other tool on the machine
// backs up independently. Replacing a non-empty note echoes the previous text
// to stderr so it survives in scrollback; append mode adds to it instead.
// stdout is untouched, so anything parsing output is unaffected.
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

// The change record is already keyed by Contacts property name and its dates
// are already Date objects, so there is nothing left to decide here.
function applyScalars(person, scalars) {
	const props = Object.keys(scalars);
	for (let i = 0; i < props.length; i++) {
		person[props[i]] = scalars[props[i]];
	}
}

// The single collection writer. Both input dialects reach it through the same
// record, so the mode says what to do rather than which parser produced it --
// there used to be four writers over two disjoint key spaces, and which ones
// ran depended on a source flag carried down from readInput.
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

function clearCollection(app, person, spec) {
	const items = person[spec.coll]();
	// Backwards: deleting shifts the indices of everything after.
	for (let j = items.length - 1; j >= 0; j--) {
		app.delete(items[j]);
	}
}

// --- Commands and dispatch ---

// A three-line shell around buildChange: read argv, read stdin, normalise.
// Only this function touches stdin, which is why the logic is not in it.
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

function cmdList(args) {
	const flags = parseArgs(args, 1, KNOWN_FLAGS.list).flags;
	const format = outputFormat(flags);
	const app = getApp();

	const collection = flags.group
		? resolveGroup(app, flags.group).people
		: app.people;

	printSummaries(readSummaries(collection), format);
}

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

function cmdGet(args) {
	const parsed = parseArgs(args, 1, KNOWN_FLAGS.get);
	const format = outputFormat(parsed.flags);
	if (parsed.positionals.length === 0) exitWithError("usage: cx get <id>", 1);
	const app = getApp();
	const record = readCard(resolveId(app, parsed.positionals[0]));
	emit(format, record, () => formatCard(record));
}

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

function cmdGroups(args) {
	const parsed = parseArgs(args, 1, KNOWN_FLAGS.groups);
	if (parsed.positionals.length === 0) {
		exitWithError("usage: cx groups <subcommand> [args]", 1);
	}
	const sub = parsed.positionals[0];
	const rest = parsed.positionals.slice(1);
	const format = outputFormat(parsed.flags);
	const app = getApp();

	switch (sub) {
		case "list":
			groupsList(app, format);
			break;
		case "members":
			if (rest.length < 1) exitWithError("usage: cx groups members <name>", 1);
			groupsMembers(app, rest[0], format);
			break;
		case "add":
			if (rest.length < 2)
				exitWithError("usage: cx groups add <contact-id> <group-name>", 1);
			groupsAdd(app, rest[0], rest[1], format);
			break;
		case "remove":
			if (rest.length < 2)
				exitWithError("usage: cx groups remove <contact-id> <group-name>", 1);
			groupsRemove(app, rest[0], rest[1], format);
			break;
		case "create":
			if (rest.length < 1) exitWithError("usage: cx groups create <name>", 1);
			groupsCreate(app, rest[0], format);
			break;
		case "delete":
			if (rest.length < 1)
				exitWithError("usage: cx groups delete <name> [--force]", 1);
			groupsDelete(app, rest[0], parsed.flags, format);
			break;
		default:
			exitWithError(`unknown groups subcommand: ${sub}`, 1);
	}
}

function groupsList(app, format) {
	const names = app.groups.name();
	names.sort();
	emit(format, names, () =>
		names.length === 0 ? "(no groups)" : names.join("\n"),
	);
}

function groupsMembers(app, name, format) {
	printSummaries(readSummaries(resolveGroup(app, name).people), format);
}

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

function groupsCreate(app, name, format) {
	if (findGroup(app, name)) exitWithError(`group already exists: ${name}`, 1);

	const group = app.Group({ name: name });
	app.groups.push(group);
	saveOrFail(app);
	emit(
		format,
		{ action: "group-created", group: name },
		() => `Created group: ${name}`,
	);
}

function groupsDelete(app, name, flags, format) {
	const group = resolveGroup(app, name);

	if (!flags.force) {
		const memberCount = group.people().length;
		emit(
			format,
			{ action: "confirmation-required", group: name, members: memberCount },
			() => `Will delete group: ${name} (${memberCount} members)`,
		);
		exitAwaitingConfirmation(format);
	}

	app.delete(group);
	saveOrFail(app);
	emit(
		format,
		{ action: "group-deleted", group: name },
		() => `Deleted group: ${name}`,
	);
}

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

// --- Selftest ---

// Everything the selftest covers lives above the Contacts banner, and the
// function itself touches nothing, so it sits here rather than among the
// command bodies -- 200 lines of fixture between readInput and cmdCreate
// made the one transition in the file that reads as a jump rather than a
// call. It is still dispatched from main() like any other command.
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
		{ label: "home", value: "https://example.com" },
	);
	check(
		"parseLabelValue labels a URL when asked",
		parseLabelValue("site:https://example.com", "home"),
		{ label: "site", value: "https://example.com" },
	);
	// The reported class: any scheme that is not one of the four someone
	// happened to list used to be split, storing //host under a label.
	check(
		"parseLabelValue leaves an unlisted scheme alone",
		parseLabelValue("ssh://host", "home"),
		{ label: "home", value: "ssh://host" },
	);
	check(
		"parseLabelValue labels an unlisted scheme when asked",
		parseLabelValue("work:ssh://host", "home"),
		{ label: "work", value: "ssh://host" },
	);
	// Shape alone cannot tell these from a label, so the named pair stays.
	check(
		"parseLabelValue leaves a slashless scheme alone",
		parseLabelValue("mailto:a@b.com", "home"),
		{ label: "home", value: "mailto:a@b.com" },
	);
	check(
		"parseLabelValue leaves tel alone",
		parseLabelValue("tel:+15550100", "home"),
		{ label: "home", value: "tel:+15550100" },
	);
	// A label is user prose, so it keeps splitting even before a slash pair.
	check(
		"parseLabelValue splits a label that is not scheme-shaped",
		parseLabelValue("my note://x", "home"),
		{ label: "my note", value: "//x" },
	);

	check(
		"unwrapLabel unwraps a built-in label",
		unwrapLabel("_$!<Mobile>!$_"),
		"Mobile",
	);
	check(
		"unwrapLabel passes a custom label through",
		unwrapLabel("rep mobile"),
		"rep mobile",
	);

	check("fit truncates and keeps a gutter", fit("abcdef", 4), "abc ");
	check("fit pads when short", fit("ab", 4), "ab  ");

	check(
		"formatDate uses local components",
		formatDate(new Date(1990, 4, 14, 12, 0, 0)),
		"1990-05-14",
	);
	check(
		"parseDateFlag round-trips",
		formatDate(parseDateFlag("1990-05-14", "birthday")),
		"1990-05-14",
	);

	check(
		"parseArgs separates flags from positionals",
		parseArgs(["delete", "--force", "a1b2c3d4"], 1, KNOWN_FLAGS.delete),
		{ flags: { force: true }, positionals: ["a1b2c3d4"] },
	);
	check(
		"parseArgs accumulates a repeatable flag",
		parseArgs(
			["create", "--email", "a", "--email", "b"],
			1,
			KNOWN_FLAGS.create,
		),
		{ flags: { email: ["a", "b"] }, positionals: [] },
	);

	// buildChange is pure, so the whole write-input mapping is checkable here.
	// Before it existed, every one of these could only be reached by creating a
	// real contact in the user's address book.
	const change = (flags, payload) => buildChange(flags, payload);

	check(
		"buildChange keys scalars by Contacts property",
		change({ first: "Ada", org: "Analytical" }).scalars,
		{ firstName: "Ada", organization: "Analytical" },
	);
	check(
		"buildChange parses a scalar date rather than passing the string on",
		formatDate(change({ birthday: "1990-05-14" }).scalars.birthDate),
		"1990-05-14",
	);
	check(
		"buildChange appends for flag input",
		change({ email: ["work:a@b.co"] }).collections.emails,
		{ mode: "append", items: [{ label: "work", value: "a@b.co" }] },
	);
	check(
		"buildChange replaces for payload input",
		change({}, { emails: [{ label: "home", value: "c@d.co" }] }).collections
			.emails,
		{ mode: "replace", items: [{ label: "home", value: "c@d.co" }] },
	);
	check(
		"buildChange lets --replace switch a flag collection to replace mode",
		change({ replace: ["email"], email: ["work:a@b.co"] }).collections.emails,
		{ mode: "replace", items: [{ label: "work", value: "a@b.co" }] },
	);
	check(
		"buildChange accepts the plural spelling the README teaches",
		change({ replace: ["emails"] }).collections.emails,
		{ mode: "replace", items: [] },
	);
	// The four collections a payload used to parse and then silently discard,
	// because their MULTI rows carried no json key to filter on.
	check(
		"buildChange writes the collections a payload used to drop",
		Object.keys(
			change(
				{},
				{
					urls: [{ value: "https://example.com" }],
					relatedNames: [{ value: "Ada" }],
					customDates: [{ value: "2000-01-02" }],
				},
			).collections,
		).sort(),
		["customDates", "relatedNames", "urls"],
	);
	check(
		"buildChange parses a payload date, not just a flag one",
		formatDate(
			change({}, { customDates: [{ value: "2000-01-02" }] }).collections
				.customDates.items[0].value,
		),
		"2000-01-02",
	);
	// A repeated flag alongside --json used to be discarded entirely: cmdUpdate
	// branched on which dialect the input came from and ran only that pipeline.
	check(
		"buildChange keeps flag items when a payload names the same collection",
		change(
			{ email: ["work:flag@b.co"] },
			{ emails: [{ label: "home", value: "json@b.co" }] },
		).collections.emails,
		{
			mode: "replace",
			items: [
				{ label: "home", value: "json@b.co" },
				{ label: "work", value: "flag@b.co" },
			],
		},
	);
	check(
		"buildChange defaults the note to replace mode",
		change({ note: "text" }).note,
		{ mode: "replace", text: "text" },
	);
	check(
		"buildChange marks an appended note",
		change({ "note-append": "more" }).note,
		{ mode: "append", text: "more" },
	);

	check(
		"summaryRecord names an unnamed contact",
		summaryRecord("A1B2C3D4-0000:ABPerson", null, null, [], []),
		{
			id: "A1B2C3D4-0000:ABPerson",
			shortId: "A1B2C3D4",
			name: "(no name)",
			email: "",
			phone: "",
			organization: "",
		},
	);
	check(
		"summaryRecord takes the first of each collection",
		summaryRecord(
			"A1B2C3D4-0000:ABPerson",
			"Ada",
			"Acme",
			["a@b.co", "c@d.co"],
			["555", "666"],
		),
		{
			id: "A1B2C3D4-0000:ABPerson",
			shortId: "A1B2C3D4",
			name: "Ada",
			email: "a@b.co",
			phone: "555",
			organization: "Acme",
		},
	);

	// The record readSearchables produces, written out once. The haystack is
	// values only, in catalogue order: name, firstName, lastName, organization,
	// note, then every email and every phone.
	const searchable = {
		summary: {
			id: "A1B2C3D4-0000:ABPerson",
			shortId: "A1B2C3D4",
			name: "Ada Lovelace",
			email: "ada@analytical.example",
			phone: "555-0100",
			organization: "Analytical Engines",
		},
		haystack: [
			"Ada Lovelace",
			"Ada",
			"Lovelace",
			"Analytical Engines",
			null,
			"ada@analytical.example",
			"ada@home.example",
			"555-0100",
		],
	};

	check(
		"matchesQuery finds a substring",
		matchesQuery(searchable, "Lovel"),
		true,
	);
	check(
		"matchesQuery ignores case, as whose({_contains}) did",
		matchesQuery(searchable, "LOVELACE"),
		true,
	);
	check(
		"matchesQuery does not fold diacritics, as whose({_contains}) did not",
		matchesQuery({ haystack: ["Marissa Calderón"] }, "Calderon"),
		false,
	);
	// The three surfaces no whose() specifier could reach.
	check(
		"matchesQuery searches an email address",
		matchesQuery(searchable, "analytical.example"),
		true,
	);
	check(
		"matchesQuery searches a phone number",
		matchesQuery(searchable, "555-0100"),
		true,
	);
	check(
		"matchesQuery searches the note",
		matchesQuery(
			{ haystack: [null, "lent them the difference engine"] },
			"difference",
		),
		true,
	);
	// readSummary kept only the first of each collection, so even a widened
	// whose() would have missed this one.
	check(
		"matchesQuery searches past the first item of a collection",
		matchesQuery(searchable, "ada@home"),
		true,
	);
	check(
		"matchesQuery steps over a null note rather than throwing",
		matchesQuery({ haystack: [null, "Ada"] }, "Ada"),
		true,
	);
	check(
		"matchesQuery misses an all-null haystack",
		matchesQuery({ haystack: [null] }, "a"),
		false,
	);
	check(
		"matchesQuery misses an empty haystack",
		matchesQuery({ haystack: [] }, "a"),
		false,
	);
	check(
		"matchesQuery misses when nothing contains the query",
		matchesQuery(searchable, "Babbage"),
		false,
	);
	// What whose({_contains: ""}) did, pinned so it is a decision not a surprise.
	check(
		"matchesQuery treats an empty query as matching anything non-empty",
		matchesQuery(searchable, ""),
		true,
	);

	// The boundary: what leaves filterSearch is what printSummaries renders and
	// --format json serialises. A haystack key here is a leak into stdout.
	check(
		"filterSearch returns summaries, not search records",
		filterSearch([searchable], "Ada"),
		[searchable.summary],
	);
	check("filterSearch drops a miss", filterSearch([searchable], "Babbage"), []);

	// A plural fetch of a guarded property throws -1728 for the whole array, so
	// there is nothing for a try/catch to guard: the row must never be
	// searchable, or cx search dies on every query for everyone.
	check(
		"no guarded field is searchable",
		searchRows(SCALARS)
			.filter((spec) => spec.guarded)
			.map((spec) => spec.prop),
		[],
	);
	check(
		"searchRows reads the catalogue rather than a hard-coded list",
		searchRows(MULTI).map((spec) => spec.coll),
		["emails", "phones"],
	);

	check(
		"formatTable reports an empty result",
		formatTable([]),
		"(no contacts)",
	);
	check(
		"formatTable sizes columns to the data",
		formatTable([
			{
				shortId: "A1B2C3D4",
				name: "Ada",
				email: "a@b.co",
				phone: "555",
				organization: "Acme",
			},
		]).split("\n")[0],
		"ID        Name  Email   Phone  Organization",
	);

	check(
		"formatCard renders a record",
		formatCard({
			id: "A1B2C3D4-0000:ABPerson",
			fields: { name: "Ada L", firstName: "Ada", note: "hello" },
			multi: {
				emails: [{ label: "work", value: "a@b.co" }],
				phones: [],
				urls: [],
				relatedNames: [],
				instantMessages: [],
				customDates: [],
			},
			addresses: [],
			socialProfiles: [],
			groups: ["Friends"],
		}),
		[
			"ID:           A1B2C3D4 (A1B2C3D4-0000:ABPerson)",
			"Name:         Ada L",
			"First:        Ada",
			"work:         a@b.co",
			"Groups:       Friends",
			"",
			"Note:",
			"hello",
		].join("\n"),
	);

	if (failures.length > 0) {
		writeStderr(`selftest: ${failures.length} failed`);
		for (let i = 0; i < failures.length; i++) writeStderr(`  ${failures[i]}`);
		$.exit(1);
	}
	writeStdout("selftest: ok");
}

// --- Run ---

main();
