ObjC.import("Foundation");
ObjC.import("stdlib");

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
	$.exit(code || 1);
}

// The two-step --force protocol: print what would be destroyed, exit 5, and
// let the caller decide. Not an error, so it does not go through stderr.
function exitAwaitingConfirmation(format) {
	if (format !== "json") writeStdout("\nRe-run with --force to confirm.");
	$.exit(5);
}

// --- Contacts.app helpers ---

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
			);
		}
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

function shortId(fullId) {
	return String(fullId).substring(0, 8);
}

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

// Custom dates come back as Date objects; every other multi-value is a string.
function formatValue(value) {
	return value && typeof value.getFullYear === "function"
		? formatDate(value)
		: value;
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
			list.push({
				label: unwrapLabel(items[m].label() || spec.display),
				value: formatValue(items[m].value()),
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

// --- Usage ---

const USAGE = [
	"Usage: cx <command> [options]",
	"",
	"Commands:",
	"  list [--group <name>]                    List contacts",
	"  search <query>                           Search contacts",
	"  get <id>                                 Show contact details",
	"  create --first <n> --last <n> [opts]     Create contact",
	"  update <id> [opts]                       Update contact",
	"  delete <id> [--force]                    Delete contact",
	"  groups list                              List groups",
	"  groups members <name>                    List group members",
	"  groups add <id> <group>                  Add contact to group",
	"  groups remove <id> <group>               Remove contact from group",
	"  groups create <name>                     Create group",
	"  groups delete <name> [--force]           Delete group",
	"",
	"Multi-value flags (--email, --phone, --url, --related, --date):",
	"  Repeat for multiple values. Use label:value syntax.",
	"  Example: --email work:me@co.com --email home:me@home.com",
	"",
	"  --json    Read full contact JSON from stdin (create/update only)",
].join("\n");

// --- Command dispatch ---

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

// --- Multi-value field helpers ---

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
		if (!spec.flag || spec.manual) continue;
		if (fields[spec.flag] === undefined) continue;
		person[spec.prop] =
			spec.type === "date"
				? parseDateFlag(fields[spec.flag], spec.flag)
				: fields[spec.flag];
	}
}

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
	}
	addObjectCollections(app, person, fields);
}

function addObjectCollections(app, person, fields) {
	for (let i = 0; i < MULTI.length; i++) {
		const spec = MULTI[i];
		if (!spec.json || !fields[spec.json]) continue;
		const items = fields[spec.json];
		for (let j = 0; j < items.length; j++) {
			person[spec.coll].push(
				app[spec.ctor]({
					label: items[j].label || spec.defaultLabel,
					value: items[j].value,
				}),
			);
		}
	}
}

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
}
function cmdGet(args) {
	const parsed = parseArgs(args, 1);
	const format = outputFormat(parsed.flags);
	if (parsed.positionals.length === 0) exitWithError("usage: cx get <id>", 1);
	const app = getApp();
	const record = readCard(resolveId(app, parsed.positionals[0]));
	emit(format, record, () => formatCard(record));
}
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
}
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
}
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
}
function cmdGroups(args) {
	const parsed = parseArgs(args, 1);
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

// --- Run ---

main();
