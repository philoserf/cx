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
	if (birthday)
		lines.push(`Birthday:     ${birthday.toISOString().substring(0, 10)}`);

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
			lines.push(padRight(`${label}:`, 14) + items[m].value());
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
		person.birthDate = new Date(flags.birthday);
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
				app.CustomDate({ label: dt.label, value: dt.value }),
			);
		}
	}
}

// --- Commands ---

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

	if (flags.group) {
		const groups = app.groups.whose({ name: flags.group })();
		if (groups.length === 0)
			exitWithError(`group not found: ${flags.group}`, 3);
		app.add(person, { to: groups[0] });
	}

	app.save();
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

	applyScalarFields(person, flags);

	if (!flags.json) {
		addMultiValueFields(app, person, flags);
	}

	app.save();
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
	app.save();
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

	const people = groups[0].people();
	const summaries = [];
	for (let i = 0; i < people.length; i++) {
		summaries.push(contactSummary(people[i]));
	}
	summaries.sort((a, b) => a.name.localeCompare(b.name));
	writeStdout(formatTable(summaries));
}

function groupsAdd(app, contactId, groupName) {
	const person = resolveId(app, contactId);
	const groups = app.groups.whose({ name: groupName })();
	if (groups.length === 0) exitWithError(`group not found: ${groupName}`, 3);

	app.add(person, { to: groups[0] });
	app.save();
	writeStdout(`Added ${person.name() || "(no name)"} to ${groupName}`);
}

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
	app.save();
	writeStdout(`Deleted group: ${name}`);
}

// --- Run ---

main();
