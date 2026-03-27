"use strict";

ObjC.import("Foundation");

// --- Stderr / Stdout helpers ---

function writeStderr(msg) {
  var stderr = $.NSFileHandle.fileHandleWithStandardError;
  var str = $.NSString.alloc.initWithUTF8String(msg + "\n");
  stderr.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
}

function writeStdout(msg) {
  var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  var str = $.NSString.alloc.initWithUTF8String(msg + "\n");
  stdout.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
}

function readStdin() {
  var stdin = $.NSFileHandle.fileHandleWithStandardInput;
  var data = stdin.readDataToEndOfFile;
  var str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return ObjC.unwrap(str);
}

// --- Exit helper ---

function exitWithError(message, code) {
  writeStderr("error: " + message);
  ObjC.import("stdlib");
  $.exit(code || 1);
}

// --- Contacts.app helpers ---

function getApp() {
  try {
    return Application("Contacts");
  } catch (e) {
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
    var p = app.people.byId(idArg);
    p.name(); // force evaluation — throws if not found
    return p;
  } catch (e) {
    // Not a full ID — try short ID match
  }

  var allPeople = app.people();
  var matches = [];
  for (var i = 0; i < allPeople.length; i++) {
    if (allPeople[i].id().indexOf(idArg) === 0) {
      matches.push(allPeople[i]);
    }
  }

  if (matches.length === 0) {
    exitWithError("no contact matching ID " + idArg, 3);
  }
  if (matches.length > 1) {
    var lines = [
      "ambiguous ID " + idArg + " matches " + matches.length + " contacts:",
    ];
    for (var j = 0; j < matches.length; j++) {
      lines.push("  " + shortId(matches[j].id()) + "  " + matches[j].name());
    }
    exitWithError(lines.join("\n"), 4);
  }
  return matches[0];
}

function contactSummary(person) {
  var name = person.name() || "(no name)";
  var email = "";
  var phone = "";
  var org = person.organization() || "";

  var emails = person.emails();
  if (emails.length > 0) email = emails[0].value();

  var phones = person.phones();
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

  var lines = [];
  var header =
    padRight("ID", 10) +
    padRight("Name", 30) +
    padRight("Email", 30) +
    padRight("Phone", 18) +
    "Organization";
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (var i = 0; i < summaries.length; i++) {
    var s = summaries[i];
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
  if (str.length >= len) return str.substring(0, len - 1) + " ";
  return str + " ".repeat(len - str.length);
}

function formatCard(person) {
  var lines = [];
  var id = person.id();

  lines.push("ID:           " + shortId(id) + " (" + id + ")");

  var nameFields = [
    ["Name", person.name()],
    ["First", person.firstName()],
    ["Last", person.lastName()],
    ["Middle", person.middleName()],
    [
      "Prefix",
      (function () {
        try {
          return person.namePrefix();
        } catch (e) {
          return null;
        }
      })(),
    ],
    ["Suffix", person.suffix()],
    ["Nickname", person.nickname()],
    ["Maiden", person.maidenName()],
  ];
  for (var i = 0; i < nameFields.length; i++) {
    if (nameFields[i][1])
      lines.push(padRight(nameFields[i][0] + ":", 14) + nameFields[i][1]);
  }

  var orgFields = [
    ["Organization", person.organization()],
    ["Job Title", person.jobTitle()],
    ["Department", person.department()],
  ];
  for (var j = 0; j < orgFields.length; j++) {
    if (orgFields[j][1])
      lines.push(padRight(orgFields[j][0] + ":", 14) + orgFields[j][1]);
  }

  var birthday = person.birthDate();
  if (birthday)
    lines.push("Birthday:     " + birthday.toISOString().substring(0, 10));

  var multiFields = [
    ["Email", person.emails()],
    ["Phone", person.phones()],
    ["URL", person.urls()],
    ["Related", person.relatedNames()],
    ["IM", person.instantMessages()],
    ["Date", person.customDates()],
  ];
  for (var k = 0; k < multiFields.length; k++) {
    var items = multiFields[k][1];
    for (var m = 0; m < items.length; m++) {
      var label = items[m].label() || multiFields[k][0];
      lines.push(padRight(label + ":", 14) + items[m].value());
    }
  }

  var addresses = person.addresses();
  for (var a = 0; a < addresses.length; a++) {
    var addr = addresses[a];
    var formatted = addr.formattedAddress();
    var addrLabel = addr.label() || "Address";
    lines.push(
      padRight(addrLabel + ":", 14) + (formatted || "").replace(/\n/g, ", "),
    );
  }

  var socialProfiles = person.socialProfiles();
  for (var s = 0; s < socialProfiles.length; s++) {
    var sp = socialProfiles[s];
    var svc = sp.serviceName() || "Social";
    var user = sp.userName() || sp.url() || "";
    lines.push(padRight(svc + ":", 14) + user);
  }

  var groups = person.groups();
  if (groups.length > 0) {
    var groupNames = groups.map(function (g) {
      return g.name();
    });
    lines.push("Groups:       " + groupNames.join(", "));
  }

  var note = person.note();
  if (note) {
    lines.push("");
    lines.push("Note:");
    lines.push(note);
  }

  return lines.join("\n");
}

// --- Arg parsing ---

function getArgs() {
  var allArgs = ObjC.unwrap($.NSProcessInfo.processInfo.arguments);
  var args = [];
  var pastSeparator = false;
  for (var i = 0; i < allArgs.length; i++) {
    var arg = ObjC.unwrap(allArgs[i]);
    if (pastSeparator) args.push(arg);
    else if (arg === "--") pastSeparator = true;
  }
  return args;
}

function parseFlags(args, startIndex) {
  var flags = {};
  var repeatable = ["email", "phone", "url", "related", "date"];
  for (var i = startIndex; i < args.length; i++) {
    if (args[i].indexOf("--") === 0) {
      var key = args[i].substring(2);
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
        exitWithError("flag --" + key + " requires a value", 1);
      }
    }
  }
  return flags;
}

// --- Usage ---

var USAGE = [
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
  var args = getArgs();
  if (args.length === 0) {
    writeStdout(USAGE);
    return;
  }

  var command = args[0];

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
      exitWithError("unknown command: " + command + "\n\n" + USAGE, 1);
  }
}

// --- Multi-value field helpers ---

function parseLabelValue(str, defaultLabel) {
  var colonIdx = str.indexOf(":");
  if (colonIdx > 0 && colonIdx < str.length - 1) {
    var beforeColon = str.substring(0, colonIdx);
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
    for (var i = 0; i < flags.email.length; i++) {
      var e = parseLabelValue(flags.email[i], "home");
      person.emails.push(app.Email({ label: e.label, value: e.value }));
    }
  }
  if (flags.phone) {
    for (var j = 0; j < flags.phone.length; j++) {
      var ph = parseLabelValue(flags.phone[j], "home");
      person.phones.push(app.Phone({ label: ph.label, value: ph.value }));
    }
  }
  if (flags.url) {
    for (var k = 0; k < flags.url.length; k++) {
      var u = parseLabelValue(flags.url[k], "home");
      person.urls.push(app.Url({ label: u.label, value: u.value }));
    }
  }
  if (flags.related) {
    for (var r = 0; r < flags.related.length; r++) {
      var rel = parseLabelValue(flags.related[r], "friend");
      person.relatedNames.push(
        app.RelatedName({ label: rel.label, value: rel.value }),
      );
    }
  }
  if (flags.date) {
    for (var d = 0; d < flags.date.length; d++) {
      var dt = parseLabelValue(flags.date[d], "anniversary");
      person.customDates.push(
        app.CustomDate({ label: dt.label, value: dt.value }),
      );
    }
  }
}

// --- Commands ---

function cmdList(args) {
  var flags = parseFlags(args, 1);
  var app = getApp();

  var people;
  if (flags.group) {
    var groups = app.groups.whose({ name: flags.group })();
    if (groups.length === 0)
      exitWithError("group not found: " + flags.group, 3);
    people = groups[0].people();
  } else {
    people = app.people();
  }

  var summaries = [];
  for (var i = 0; i < people.length; i++) {
    summaries.push(contactSummary(people[i]));
  }

  summaries.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  writeStdout(formatTable(summaries));
}
function cmdSearch(args) {
  if (args.length < 2) exitWithError("usage: cx search <query>", 1);
  var query = args[1];
  var app = getApp();

  var people = app.people.whose({
    _or: [
      { firstName: { _contains: query } },
      { lastName: { _contains: query } },
      { name: { _contains: query } },
      { organization: { _contains: query } },
    ],
  })();

  var summaries = [];
  for (var i = 0; i < people.length; i++) {
    summaries.push(contactSummary(people[i]));
  }

  summaries.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  writeStdout(formatTable(summaries));
}
function cmdGet(args) {
  if (args.length < 2) exitWithError("usage: cx get <id>", 1);
  var app = getApp();
  var person = resolveId(app, args[1]);
  writeStdout(formatCard(person));
}
function cmdCreate(args) {
  var flags = parseFlags(args, 1);
  var app = getApp();

  if (flags.json) {
    var input = readStdin().trim();
    if (!input) exitWithError("--json requires JSON on stdin", 1);
    try {
      flags = JSON.parse(input);
    } catch (e) {
      exitWithError("invalid JSON: " + e.message, 1);
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

  var personProps = {};
  if (flags.first) personProps.firstName = flags.first;
  if (flags.last) personProps.lastName = flags.last;

  var person = app.Person(personProps);
  app.people.push(person);

  applyScalarFields(person, flags);

  if (flags.json && !Array.isArray(flags.email)) {
    if (flags.emails) {
      for (var i = 0; i < flags.emails.length; i++) {
        person.emails.push(
          app.Email({
            label: flags.emails[i].label || "home",
            value: flags.emails[i].value,
          }),
        );
      }
    }
    if (flags.phones) {
      for (var j = 0; j < flags.phones.length; j++) {
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
    var groups = app.groups.whose({ name: flags.group })();
    if (groups.length === 0)
      exitWithError("group not found: " + flags.group, 3);
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
  exitWithError("update not yet implemented", 1);
}
function cmdDelete(args) {
  exitWithError("delete not yet implemented", 1);
}
function cmdGroups(args) {
  exitWithError("groups not yet implemented", 1);
}

// --- Run ---

main();
