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
function validateFields(flags) {
	if (flags.birthday !== undefined) parseDateFlag(flags.birthday, "birthday");
	if (flags.date) {
		for (let i = 0; i < flags.date.length; i++) {
			const dt = parseLabelValue(flags.date[i], "anniversary");
			parseDateFlag(dt.value, "date");
		}
	}
}

function resolveGroup(app, name) {
	const groups = app.groups.whose({ name: name })();
	if (groups.length === 0) exitWithError(`group not found: ${name}`, 3);
	return groups[0];
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

// One Apple Event per property for a whole collection, instead of one per
// contact per property. Measured at 341 contacts: five plural calls total
// ~0.7s, against ~48s for the equivalent per-contact loop.
//
// Only valid on an element collection — app.people, or a group's people.
// Plural access on a whose() specifier measured 13.3s for 256 names, worse
// than the loop, so cmdSearch keeps contactSummary.
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

	const lines = [];
	const header =
		padRight("ID", 10) +
		padRight("Name", 30) +
		padRight("Email", 30) +
		padRight("Phone", 18) +
		"Organization";
	lines.push(header);
	lines.push("-".repeat(header.length));

	for (let i = 0; i < summaries.length; i++) {
		const s = summaries[i];
		lines.push(
			padRight(s.shortId, 10) +
				padRight(s.name, 30) +
				padRight(s.email, 30) +
				padRight(s.phone, 18) +
				s.organization,
		);
	}
	return lines.join("\n");
}

function padRight(str, len) {
	if (str.length >= len) return `${str.substring(0, len - 1)} `;
	return str + " ".repeat(len - str.length);
}

function formatCard(person) {
	const lines = [];
	const id = person.id();

	lines.push(`ID:           ${shortId(id)} (${id})`);

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
		["Suffix", person.suffix()],
		["Nickname", person.nickname()],
		["Maiden", person.maidenName()],
	];
	for (let i = 0; i < nameFields.length; i++) {
		if (nameFields[i][1])
			lines.push(padRight(`${nameFields[i][0]}:`, 14) + nameFields[i][1]);
	}

	const orgFields = [
		["Organization", person.organization()],
		["Job Title", person.jobTitle()],
		["Department", person.department()],
	];
	for (let j = 0; j < orgFields.length; j++) {
		if (orgFields[j][1])
			lines.push(padRight(`${orgFields[j][0]}:`, 14) + orgFields[j][1]);
	}

	const birthday = person.birthDate();
	if (birthday) lines.push(`Birthday:     ${formatDate(birthday)}`);

	const multiFields = [
		["Email", person.emails()],
		["Phone", person.phones()],
		["URL", person.urls()],
		["Related", person.relatedNames()],
		["IM", person.instantMessages()],
		["Date", person.customDates()],
	];
	for (let k = 0; k < multiFields.length; k++) {
		const items = multiFields[k][1];
		for (let m = 0; m < items.length; m++) {
			const label = items[m].label() || multiFields[k][0];
			lines.push(padRight(`${label}:`, 14) + formatValue(items[m].value()));
		}
	}

	const addresses = person.addresses();
	for (let a = 0; a < addresses.length; a++) {
		const addr = addresses[a];
		const formatted = addr.formattedAddress();
		const addrLabel = addr.label() || "Address";
		lines.push(
			padRight(`${addrLabel}:`, 14) + (formatted || "").replace(/\n/g, ", "),
		);
	}

	const socialProfiles = person.socialProfiles();
	for (let s = 0; s < socialProfiles.length; s++) {
		const sp = socialProfiles[s];
		const svc = sp.serviceName() || "Social";
		const user = sp.userName() || sp.url() || "";
		lines.push(padRight(`${svc}:`, 14) + user);
	}

	const groups = person.groups();
	if (groups.length > 0) {
		const groupNames = groups.map((g) => g.name());
		lines.push(`Groups:       ${groupNames.join(", ")}`);
	}

	const note = person.note();
	if (note) {
		lines.push("");
		lines.push("Note:");
		lines.push(note);
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
		person.birthDate = parseDateFlag(flags.birthday, "birthday");
	}
}

function addMultiValueFields(app, person, flags) {
	if (flags.email) {
		for (let i = 0; i < flags.email.length; i++) {
			const e = parseLabelValue(flags.email[i], "home");
			person.emails.push(app.Email({ label: e.label, value: e.value }));
		}
	}
	if (flags.phone) {
		for (let j = 0; j < flags.phone.length; j++) {
			const ph = parseLabelValue(flags.phone[j], "home");
			person.phones.push(app.Phone({ label: ph.label, value: ph.value }));
		}
	}
	if (flags.url) {
		for (let k = 0; k < flags.url.length; k++) {
			const u = parseLabelValue(flags.url[k], "home");
			person.urls.push(app.Url({ label: u.label, value: u.value }));
		}
	}
	if (flags.related) {
		for (let r = 0; r < flags.related.length; r++) {
			const rel = parseLabelValue(flags.related[r], "friend");
			person.relatedNames.push(
				app.RelatedName({ label: rel.label, value: rel.value }),
			);
		}
	}
	if (flags.date) {
		for (let d = 0; d < flags.date.length; d++) {
			const dt = parseLabelValue(flags.date[d], "anniversary");
			person.customDates.push(
				app.CustomDate({
					label: dt.label,
					value: parseDateFlag(dt.value, "date"),
				}),
			);
		}
	}
}

// --- Commands ---

function cmdList(args) {
	const flags = parseFlags(args, 1);
	const app = getApp();

	let collection;
	if (flags.group) {
		const groups = app.groups.whose({ name: flags.group })();
		if (groups.length === 0)
			exitWithError(`group not found: ${flags.group}`, 3);
		collection = groups[0].people;
	} else {
		collection = app.people;
	}

	const summaries = readSummaries(collection);

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

	writeStdout(formatTable(summaries));
}
function cmdGet(args) {
	if (args.length < 2) exitWithError("usage: cx get <id>", 1);
	const app = getApp();
	const person = resolveId(app, args[1]);
	writeStdout(formatCard(person));
}
function cmdCreate(args) {
	let flags = parseFlags(args, 1);
	const app = getApp();

	if (flags.json) {
		const input = readStdin().trim();
		if (!input) exitWithError("--json requires JSON on stdin", 1);
		try {
			flags = JSON.parse(input);
		} catch (e) {
			exitWithError(`invalid JSON: ${e.message}`, 1);
		}
		if (flags.firstName !== undefined) flags.first = flags.firstName;
		if (flags.lastName !== undefined) flags.last = flags.lastName;
		if (flags.middleName !== undefined) flags.middle = flags.middleName;
		if (flags.nameSuffix !== undefined) flags.suffix = flags.nameSuffix;
		if (flags.organization !== undefined) flags.org = flags.organization;
		if (flags.jobTitle !== undefined) flags.title = flags.jobTitle;
		if (flags.department !== undefined) flags.dept = flags.department;
		flags.json = true;
	}

	if (!flags.first && !flags.last) {
		exitWithError("create requires at least --first or --last", 1);
	}

	validateFields(flags);
	const targetGroup = flags.group ? resolveGroup(app, flags.group) : null;

	const personProps = {};
	if (flags.first) personProps.firstName = flags.first;
	if (flags.last) personProps.lastName = flags.last;

	const person = app.Person(personProps);
	app.people.push(person);

	applyScalarFields(person, flags);

	if (flags.json && !Array.isArray(flags.email)) {
		if (flags.emails) {
			for (let i = 0; i < flags.emails.length; i++) {
				person.emails.push(
					app.Email({
						label: flags.emails[i].label || "home",
						value: flags.emails[i].value,
					}),
				);
			}
		}
		if (flags.phones) {
			for (let j = 0; j < flags.phones.length; j++) {
				person.phones.push(
					app.Phone({
						label: flags.phones[j].label || "home",
						value: flags.phones[j].value,
					}),
				);
			}
		}
	} else {
		addMultiValueFields(app, person, flags);
	}

	if (targetGroup) app.add(person, { to: targetGroup });

	saveOrFail(app);
	writeStdout(
		"Created " +
			(person.name() || "(no name)") +
			" (" +
			shortId(person.id()) +
			")",
	);
}
function cmdUpdate(args) {
	if (args.length < 2)
		exitWithError("usage: cx update <id> [--field value ...]", 1);
	const app = getApp();
	const person = resolveId(app, args[1]);
	let flags = parseFlags(args, 2);

	if (flags.json) {
		const input = readStdin().trim();
		if (!input) exitWithError("--json requires JSON on stdin", 1);
		try {
			flags = JSON.parse(input);
		} catch (e) {
			exitWithError(`invalid JSON: ${e.message}`, 1);
		}
		if (flags.firstName !== undefined) flags.first = flags.firstName;
		if (flags.lastName !== undefined) flags.last = flags.lastName;
		if (flags.middleName !== undefined) flags.middle = flags.middleName;
		if (flags.nameSuffix !== undefined) flags.suffix = flags.nameSuffix;
		if (flags.organization !== undefined) flags.org = flags.organization;
		if (flags.jobTitle !== undefined) flags.title = flags.jobTitle;
		if (flags.department !== undefined) flags.dept = flags.department;
		flags.json = true;
	}

	validateFields(flags);
	applyScalarFields(person, flags);

	if (!flags.json) {
		addMultiValueFields(app, person, flags);
	}

	saveOrFail(app);
	writeStdout(
		"Updated " +
			(person.name() || "(no name)") +
			" (" +
			shortId(person.id()) +
			")",
	);
}
function cmdDelete(args) {
	if (args.length < 2) exitWithError("usage: cx delete <id> [--force]", 1);
	const app = getApp();
	const person = resolveId(app, args[1]);
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
	saveOrFail(app);
	writeStdout(`Deleted ${name} (${sid})`);
}
function cmdGroups(args) {
	if (args.length < 2) exitWithError("usage: cx groups <subcommand> [args]", 1);
	const sub = args[1];
	const app = getApp();

	switch (sub) {
		case "list":
			groupsList(app);
			break;
		case "members":
			if (args.length < 3) exitWithError("usage: cx groups members <name>", 1);
			groupsMembers(app, args[2]);
			break;
		case "add":
			if (args.length < 4)
				exitWithError("usage: cx groups add <contact-id> <group-name>", 1);
			groupsAdd(app, args[2], args[3]);
			break;
		case "remove":
			if (args.length < 4)
				exitWithError("usage: cx groups remove <contact-id> <group-name>", 1);
			groupsRemove(app, args[2], args[3]);
			break;
		case "create":
			if (args.length < 3) exitWithError("usage: cx groups create <name>", 1);
			groupsCreate(app, args[2]);
			break;
		case "delete":
			if (args.length < 3)
				exitWithError("usage: cx groups delete <name> [--force]", 1);
			groupsDelete(app, args[2], parseFlags(args, 3));
			break;
		default:
			exitWithError(`unknown groups subcommand: ${sub}`, 1);
	}
}

function groupsList(app) {
	const groups = app.groups();
	if (groups.length === 0) {
		writeStdout("(no groups)");
		return;
	}
	const names = [];
	for (let i = 0; i < groups.length; i++) {
		names.push(groups[i].name());
	}
	names.sort();
	writeStdout(names.join("\n"));
}

function groupsMembers(app, name) {
	const groups = app.groups.whose({ name: name })();
	if (groups.length === 0) exitWithError(`group not found: ${name}`, 3);

	const summaries = readSummaries(groups[0].people);
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	writeStdout(formatTable(summaries));
}

function groupsAdd(app, contactId, groupName) {
	const person = resolveId(app, contactId);
	const groups = app.groups.whose({ name: groupName })();
	if (groups.length === 0) exitWithError(`group not found: ${groupName}`, 3);

	app.add(person, { to: groups[0] });
	saveOrFail(app);
	writeStdout(`Added ${person.name() || "(no name)"} to ${groupName}`);
}

function groupsRemove(app, contactId, groupName) {
	const person = resolveId(app, contactId);
	const groups = app.groups.whose({ name: groupName })();
	if (groups.length === 0) exitWithError(`group not found: ${groupName}`, 3);

	app.remove(person, { from: groups[0] });
	saveOrFail(app);
	writeStdout(`Removed ${person.name() || "(no name)"} from ${groupName}`);
}

function groupsCreate(app, name) {
	const existing = app.groups.whose({ name: name })();
	if (existing.length > 0) exitWithError(`group already exists: ${name}`, 1);

	const group = app.Group({ name: name });
	app.groups.push(group);
	saveOrFail(app);
	writeStdout(`Created group: ${name}`);
}

function groupsDelete(app, name, flags) {
	const groups = app.groups.whose({ name: name })();
	if (groups.length === 0) exitWithError(`group not found: ${name}`, 3);

	if (!flags.force) {
		const memberCount = groups[0].people().length;
		writeStdout(`Will delete group: ${name} (${memberCount} members)`);
		writeStdout("\nRe-run with --force to confirm.");
		ObjC.import("stdlib");
		$.exit(5);
	}

	app.delete(groups[0]);
	saveOrFail(app);
	writeStdout(`Deleted group: ${name}`);
}

// --- Run ---

main();
