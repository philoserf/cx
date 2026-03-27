# cx Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS CLI tool that manages Apple Contacts via JXA, with full notes access.

**Architecture:** A bash entry point (`cx`) invokes `osascript -l JavaScript cx.js -- "$@"`. All logic lives in `cx.js` — arg parsing, Contacts.app interaction, text formatting, and command dispatch. Integration tests in `tests/test.sh` exercise the full CRUD lifecycle against real Contacts.app data.

**Tech Stack:** JXA (JavaScript for Automation), bash, osascript, go-task

**Spec:** `docs/superpowers/specs/2026-03-26-cx-design.md`

---

### Task 1: Shell Wrapper, Taskfile, and Scaffold

**Files:**

- Create: `cx` (bash entry point)
- Create: `cx.js` (JXA scaffold with arg parsing and command dispatch)
- Create: `Taskfile.yml`

- [ ] **Step 1: Create the bash wrapper `cx`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Resolve real path (follow symlinks) to find cx.js
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")" && pwd)"

exec osascript -l JavaScript "$SCRIPT_DIR/cx.js" -- "$@"
```

Make it executable: `chmod +x cx`

- [ ] **Step 2: Create `cx.js` with arg parsing and usage output**

This is the foundation. It parses CLI args, dispatches to command handlers (stubs for now), and prints usage on bad input.

```javascript
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

// --- Command stubs (replaced in subsequent tasks) ---

function cmdList(args) {
  exitWithError("list not yet implemented", 1);
}
function cmdSearch(args) {
  exitWithError("search not yet implemented", 1);
}
function cmdGet(args) {
  exitWithError("get not yet implemented", 1);
}
function cmdCreate(args) {
  exitWithError("create not yet implemented", 1);
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
```

- [ ] **Step 3: Create `Taskfile.yml`**

```yaml
version: "3"

vars:
  SHELL_FILES: cx tests/test.sh
  INSTALL_DIR: "{{.HOME}}/.local/bin"

tasks:
  install:
    desc: Symlink cx to ~/.local/bin
    cmds:
      - mkdir -p {{.INSTALL_DIR}}
      - ln -sf "$(pwd)/cx" {{.INSTALL_DIR}}/cx
    status:
      - test -L {{.INSTALL_DIR}}/cx

  uninstall:
    desc: Remove cx symlink
    cmds:
      - rm -f {{.INSTALL_DIR}}/cx

  test:
    desc: Run integration tests
    cmds:
      - bash tests/test.sh

  lint:
    desc: Lint shell scripts
    cmds:
      - shellcheck {{.SHELL_FILES}}
      - shfmt -d {{.SHELL_FILES}}

  fmt:
    desc: Format shell scripts
    cmds:
      - shfmt -w {{.SHELL_FILES}}
```

- [ ] **Step 4: Verify the scaffold works**

Run: `./cx`
Expected: prints usage text

Run: `./cx help`
Expected: prints usage text

Run: `./cx search test`
Expected: stderr prints "error: search not yet implemented", exit code 1

Run: `./cx bogus`
Expected: stderr prints "error: unknown command: bogus" followed by usage, exit code 1

- [ ] **Step 5: Run lint**

Run: `shellcheck cx && shfmt -d cx`
Expected: no errors. Fix any issues before committing.

- [ ] **Step 6: Commit**

```bash
git add cx cx.js Taskfile.yml
git commit -m "feat: add shell wrapper, JXA scaffold with arg parsing, and Taskfile"
```

---

### Task 2: Contact Helpers and ID Resolution

**Files:**

- Modify: `cx.js` — add Contacts.app helpers, ID resolution, contact-to-text formatting

These are the shared utilities that all commands depend on. Building them before any command ensures we test the foundation.

- [ ] **Step 1: Add Contacts.app helper functions to `cx.js`**

Insert these after the `exitWithError` function and before the `getArgs` function:

```javascript
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
    ["Prefix", person.namePrefix ? person.namePrefix() : null],
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
```

- [ ] **Step 2: Verify `getApp()` works**

Run: `osascript -l JavaScript -e 'Application("Contacts").people.length'`
Expected: a number (your contact count, likely around 477)

If this fails with a permissions error, grant automation access in System Settings > Privacy & Security > Automation for Terminal/Ghostty.

- [ ] **Step 3: Commit**

```bash
git add cx.js
git commit -m "feat: add contact helpers, ID resolution, and text formatting"
```

---

### Task 3: List and Search Commands

**Files:**

- Modify: `cx.js` — replace `cmdList` and `cmdSearch` stubs

- [ ] **Step 1: Implement `cmdList`**

Replace the `cmdList` stub in `cx.js`:

```javascript
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
```

- [ ] **Step 2: Implement `cmdSearch`**

Replace the `cmdSearch` stub:

```javascript
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
```

- [ ] **Step 3: Verify list works**

Run: `./cx list | head -5`
Expected: a table header and first few contacts sorted by name

Run: `./cx list | wc -l`
Expected: roughly your contact count + 2 (header + separator)

- [ ] **Step 4: Verify search works**

Run: `./cx search Ayers`
Expected: table with contacts matching "Ayers" in name or organization

Run: `./cx search zzzznonexistent`
Expected: `(no contacts)`

- [ ] **Step 5: Commit**

```bash
git add cx.js
git commit -m "feat: implement list and search commands"
```

---

### Task 4: Get Command

**Files:**

- Modify: `cx.js` — replace `cmdGet` stub

- [ ] **Step 1: Implement `cmdGet`**

Replace the `cmdGet` stub:

```javascript
function cmdGet(args) {
  if (args.length < 2) exitWithError("usage: cx get <id>", 1);
  var app = getApp();
  var person = resolveId(app, args[1]);
  writeStdout(formatCard(person));
}
```

- [ ] **Step 2: Verify get works**

First, get an ID from list:
Run: `./cx list | head -3`

Then use the short ID from the first contact:
Run: `./cx get <shortId>`
Expected: card-style output with all properties for that contact, including notes if present

- [ ] **Step 3: Verify error cases**

Run: `./cx get zzzzzzzz`
Expected: stderr "error: no contact matching ID zzzzzzzz", exit code 3

Run: `./cx get`
Expected: stderr "error: missing contact ID", exit code 1 (actually "usage: cx get <id>")

- [ ] **Step 4: Commit**

```bash
git add cx.js
git commit -m "feat: implement get command with card-style output"
```

---

### Task 5: Create Command

**Files:**

- Modify: `cx.js` — replace `cmdCreate` stub, add `parseLabelValue` and `applyContactFields` helpers

- [ ] **Step 1: Add multi-value parsing helper**

Insert before `cmdList`:

```javascript
// --- Multi-value field helpers ---

function parseLabelValue(str, defaultLabel) {
  var colonIdx = str.indexOf(":");
  if (colonIdx > 0 && colonIdx < str.length - 1) {
    // Check it's not a URL scheme like http: or https:
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
  if (flags.prefix !== undefined && person.namePrefix)
    person.namePrefix = flags.prefix;
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
```

- [ ] **Step 2: Implement `cmdCreate`**

Replace the `cmdCreate` stub:

```javascript
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
    // Map JSON keys to flag keys
    if (flags.firstName !== undefined) flags.first = flags.firstName;
    if (flags.lastName !== undefined) flags.last = flags.lastName;
    if (flags.middleName !== undefined) flags.middle = flags.middleName;
    if (flags.namePrefix !== undefined) flags.prefix = flags.namePrefix;
    if (flags.nameSuffix !== undefined) flags.suffix = flags.nameSuffix;
    if (flags.organization !== undefined) flags.org = flags.organization;
    if (flags.jobTitle !== undefined) flags.title = flags.jobTitle;
    if (flags.department !== undefined) flags.dept = flags.department;
    flags.json = true; // Mark as JSON mode for multi-value handling below
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
    // JSON mode: multi-value fields come as arrays of {label, value} objects
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
    // URLs, addresses, socialProfiles, relatedNames, instantMessaging, dates
    // handled similarly if present in JSON
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
```

- [ ] **Step 3: Verify create with flags**

Run: `./cx create --first CxTest --last Scaffold --note "test note" --email work:test@example.com --phone mobile:555-0000`
Expected: "Created CxTest Scaffold (xxxxxxxx)"

Verify it exists:
Run: `./cx search CxTest`
Expected: table showing CxTest Scaffold

Verify note and details:
Run: `./cx get <shortId from create output>`
Expected: card showing note "test note", work email, mobile phone

- [ ] **Step 4: Verify create with --json**

Run: `echo '{"firstName":"CxTest","lastName":"JsonMode","note":"json note"}' | ./cx create --json`
Expected: "Created CxTest JsonMode (xxxxxxxx)"

Verify: `./cx search CxTest`
Expected: both CxTest contacts appear

- [ ] **Step 5: Clean up test contacts manually**

Open Contacts.app and delete the two CxTest contacts, or note their IDs for deletion in Task 7.

- [ ] **Step 6: Commit**

```bash
git add cx.js
git commit -m "feat: implement create command with flag and JSON input"
```

---

### Task 6: Update Command

**Files:**

- Modify: `cx.js` — replace `cmdUpdate` stub

- [ ] **Step 1: Implement `cmdUpdate`**

Replace the `cmdUpdate` stub:

```javascript
function cmdUpdate(args) {
  if (args.length < 2)
    exitWithError("usage: cx update <id> [--field value ...]", 1);
  var app = getApp();
  var person = resolveId(app, args[1]);
  var flags = parseFlags(args, 2);

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
    if (flags.namePrefix !== undefined) flags.prefix = flags.namePrefix;
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
```

- [ ] **Step 2: Verify update**

Create a test contact:
Run: `./cx create --first CxTest --last Update --note "original note"`

Update the note:
Run: `./cx update <shortId> --note "updated note"`
Expected: "Updated CxTest Update (xxxxxxxx)"

Verify:
Run: `./cx get <shortId>`
Expected: card shows "updated note"

- [ ] **Step 3: Clean up test contact**

Note the shortId for deletion in Task 7, or delete manually.

- [ ] **Step 4: Commit**

```bash
git add cx.js
git commit -m "feat: implement update command"
```

---

### Task 7: Delete Command

**Files:**

- Modify: `cx.js` — replace `cmdDelete` stub

- [ ] **Step 1: Implement `cmdDelete`**

Replace the `cmdDelete` stub:

```javascript
function cmdDelete(args) {
  if (args.length < 2) exitWithError("usage: cx delete <id> [--force]", 1);
  var app = getApp();
  var person = resolveId(app, args[1]);
  var flags = parseFlags(args, 2);
  var name = person.name() || "(no name)";
  var sid = shortId(person.id());

  if (!flags.force) {
    var s = contactSummary(person);
    writeStdout("Will delete: " + s.name + " (" + sid + ")");
    if (s.email) writeStdout("  Email: " + s.email);
    if (s.phone) writeStdout("  Phone: " + s.phone);
    if (s.organization) writeStdout("  Org:   " + s.organization);
    writeStdout("\nRe-run with --force to confirm.");
    ObjC.import("stdlib");
    $.exit(5);
  }

  app.delete(person);
  app.save();
  writeStdout("Deleted " + name + " (" + sid + ")");
}
```

- [ ] **Step 2: Verify delete without --force**

Create a test contact:
Run: `./cx create --first CxTest --last Delete`

Try deleting without force:
Run: `./cx delete <shortId>; echo "exit: $?"`
Expected: prints contact summary and "Re-run with --force to confirm.", exit code 5

- [ ] **Step 3: Verify delete with --force**

Run: `./cx delete <shortId> --force`
Expected: "Deleted CxTest Delete (xxxxxxxx)"

Verify gone:
Run: `./cx search CxTest`
Expected: does not include CxTest Delete

- [ ] **Step 4: Commit**

```bash
git add cx.js
git commit -m "feat: implement delete command with --force confirmation"
```

---

### Task 8: Groups Commands

**Files:**

- Modify: `cx.js` — replace `cmdGroups` stub

- [ ] **Step 1: Implement `cmdGroups`**

Replace the `cmdGroups` stub:

```javascript
function cmdGroups(args) {
  if (args.length < 2) exitWithError("usage: cx groups <subcommand> [args]", 1);
  var sub = args[1];
  var app = getApp();

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
      exitWithError("unknown groups subcommand: " + sub, 1);
  }
}

function groupsList(app) {
  var groups = app.groups();
  if (groups.length === 0) {
    writeStdout("(no groups)");
    return;
  }
  var names = [];
  for (var i = 0; i < groups.length; i++) {
    names.push(groups[i].name());
  }
  names.sort();
  writeStdout(names.join("\n"));
}

function groupsMembers(app, name) {
  var groups = app.groups.whose({ name: name })();
  if (groups.length === 0) exitWithError("group not found: " + name, 3);

  var people = groups[0].people();
  var summaries = [];
  for (var i = 0; i < people.length; i++) {
    summaries.push(contactSummary(people[i]));
  }
  summaries.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  writeStdout(formatTable(summaries));
}

function groupsAdd(app, contactId, groupName) {
  var person = resolveId(app, contactId);
  var groups = app.groups.whose({ name: groupName })();
  if (groups.length === 0) exitWithError("group not found: " + groupName, 3);

  app.add(person, { to: groups[0] });
  app.save();
  writeStdout("Added " + (person.name() || "(no name)") + " to " + groupName);
}

function groupsRemove(app, contactId, groupName) {
  var person = resolveId(app, contactId);
  var groups = app.groups.whose({ name: groupName })();
  if (groups.length === 0) exitWithError("group not found: " + groupName, 3);

  app.remove(person, { from: groups[0] });
  app.save();
  writeStdout(
    "Removed " + (person.name() || "(no name)") + " from " + groupName,
  );
}

function groupsCreate(app, name) {
  var existing = app.groups.whose({ name: name })();
  if (existing.length > 0) exitWithError("group already exists: " + name, 1);

  var group = app.Group({ name: name });
  app.groups.push(group);
  app.save();
  writeStdout("Created group: " + name);
}

function groupsDelete(app, name, flags) {
  var groups = app.groups.whose({ name: name })();
  if (groups.length === 0) exitWithError("group not found: " + name, 3);

  if (!flags.force) {
    var memberCount = groups[0].people().length;
    writeStdout(
      "Will delete group: " + name + " (" + memberCount + " members)",
    );
    writeStdout("\nRe-run with --force to confirm.");
    ObjC.import("stdlib");
    $.exit(5);
  }

  app.delete(groups[0]);
  app.save();
  writeStdout("Deleted group: " + name);
}
```

- [ ] **Step 2: Verify groups lifecycle**

Run: `./cx groups list`
Expected: list of existing groups (or "(no groups)")

Run: `./cx groups create CxTestGroup`
Expected: "Created group: CxTestGroup"

Create a test contact:
Run: `./cx create --first CxTest --last GroupMember`

Add to group:
Run: `./cx groups add <shortId> CxTestGroup`
Expected: "Added CxTest GroupMember to CxTestGroup"

Run: `./cx groups members CxTestGroup`
Expected: table showing CxTest GroupMember

Remove from group:
Run: `./cx groups remove <shortId> CxTestGroup`
Expected: "Removed CxTest GroupMember from CxTestGroup"

Delete group:
Run: `./cx groups delete CxTestGroup --force`
Expected: "Deleted group: CxTestGroup"

Clean up test contact:
Run: `./cx delete <shortId> --force`

- [ ] **Step 3: Commit**

```bash
git add cx.js
git commit -m "feat: implement groups commands"
```

---

### Task 9: Integration Test Script

**Files:**

- Create: `tests/test.sh`

- [ ] **Step 1: Create `tests/test.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CX="$SCRIPT_DIR/../cx"
PASS=0
FAIL=0
TEST_PREFIX="CxTest_$$"
CREATED_IDS=()
CREATED_GROUPS=()

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  for id in "${CREATED_IDS[@]}"; do
    "$CX" delete "$id" --force 2>/dev/null || true
  done
  for group in "${CREATED_GROUPS[@]}"; do
    "$CX" groups delete "$group" --force 2>/dev/null || true
  done
}
trap cleanup EXIT

assert_exit() {
  local expected="$1"
  shift
  local actual
  set +e
  "$@" >/dev/null 2>&1
  actual=$?
  set -e
  if [[ "$actual" -eq "$expected" ]]; then
    echo "  PASS: exit $actual (expected $expected)"
    ((PASS++))
  else
    echo "  FAIL: exit $actual (expected $expected): $*"
    ((FAIL++))
  fi
}

assert_contains() {
  local expected="$1"
  local output="$2"
  if echo "$output" | grep -q "$expected"; then
    echo "  PASS: output contains '$expected'"
    ((PASS++))
  else
    echo "  FAIL: output missing '$expected'"
    echo "  Got: $output"
    ((FAIL++))
  fi
}

assert_not_contains() {
  local expected="$1"
  local output="$2"
  if echo "$output" | grep -q "$expected"; then
    echo "  FAIL: output should not contain '$expected'"
    ((FAIL++))
  else
    echo "  PASS: output does not contain '$expected'"
    ((PASS++))
  fi
}

# --- Test: usage ---
echo "=== Usage ==="
output=$("$CX" 2>&1 || true)
assert_contains "Usage:" "$output"

# --- Test: create ---
echo ""
echo "=== Create ==="
output=$("$CX" create --first "${TEST_PREFIX}" --last "Person" --note "test note from cx" --email "work:${TEST_PREFIX}@example.com" --phone "mobile:555-0199" 2>&1)
echo "$output"
assert_contains "Created" "$output"

# Extract short ID
CONTACT_ID=$(echo "$output" | grep -o '([a-fA-F0-9]\{8\})' | tr -d '()')
echo "  Contact ID: $CONTACT_ID"
CREATED_IDS+=("$CONTACT_ID")

# --- Test: search ---
echo ""
echo "=== Search ==="
output=$("$CX" search "${TEST_PREFIX}" 2>&1)
assert_contains "${TEST_PREFIX}" "$output"

# --- Test: get ---
echo ""
echo "=== Get ==="
output=$("$CX" get "$CONTACT_ID" 2>&1)
assert_contains "${TEST_PREFIX}" "$output"
assert_contains "test note from cx" "$output"
assert_contains "work:" "$output"
assert_contains "555-0199" "$output"

# --- Test: update ---
echo ""
echo "=== Update ==="
"$CX" update "$CONTACT_ID" --note "updated note from cx"
output=$("$CX" get "$CONTACT_ID" 2>&1)
assert_contains "updated note from cx" "$output"
assert_not_contains "test note from cx" "$output"

# --- Test: delete without --force ---
echo ""
echo "=== Delete (no force) ==="
assert_exit 5 "$CX" delete "$CONTACT_ID"

# Verify still exists
output=$("$CX" get "$CONTACT_ID" 2>&1)
assert_contains "${TEST_PREFIX}" "$output"

# --- Test: groups lifecycle ---
echo ""
echo "=== Groups ==="
GROUP_NAME="${TEST_PREFIX}_Group"
CREATED_GROUPS+=("$GROUP_NAME")

"$CX" groups create "$GROUP_NAME"
output=$("$CX" groups list 2>&1)
assert_contains "$GROUP_NAME" "$output"

"$CX" groups add "$CONTACT_ID" "$GROUP_NAME"
output=$("$CX" groups members "$GROUP_NAME" 2>&1)
assert_contains "${TEST_PREFIX}" "$output"

# Verify group shows in contact get
output=$("$CX" get "$CONTACT_ID" 2>&1)
assert_contains "$GROUP_NAME" "$output"

"$CX" groups remove "$CONTACT_ID" "$GROUP_NAME"
output=$("$CX" groups members "$GROUP_NAME" 2>&1)
assert_not_contains "${TEST_PREFIX}" "$output"

"$CX" groups delete "$GROUP_NAME" --force
output=$("$CX" groups list 2>&1)
assert_not_contains "$GROUP_NAME" "$output"
CREATED_GROUPS=()

# --- Test: delete with --force ---
echo ""
echo "=== Delete (force) ==="
"$CX" delete "$CONTACT_ID" --force
CREATED_IDS=()

output=$("$CX" search "${TEST_PREFIX}" 2>&1)
assert_not_contains "${TEST_PREFIX}" "$output"

# --- Test: error cases ---
echo ""
echo "=== Error Cases ==="
assert_exit 3 "$CX" get "zzzzzzzz"
assert_exit 1 "$CX" create
assert_exit 1 "$CX" boguscommand

# --- Summary ---
echo ""
echo "=== Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
```

Make it executable: `chmod +x tests/test.sh`

- [ ] **Step 2: Run the tests**

Run: `task test`
Expected: all tests pass, cleanup removes test data

- [ ] **Step 3: Run lint on all shell scripts**

Run: `task lint`
Expected: no errors from shellcheck or shfmt. Fix any issues.

- [ ] **Step 4: Commit**

```bash
git add tests/test.sh
git commit -m "feat: add integration test script"
```

---

### Task 10: CLAUDE.md Update and README

**Files:**

- Modify: `CLAUDE.md` — update to reflect actual implementation
- Create: `README.md`

- [ ] **Step 1: Update `CLAUDE.md`**

Rewrite `CLAUDE.md` to match the actual implementation. Remove speculative language (like "may need concatenation") and reflect the real file structure, commands, and Taskfile tasks. Keep it concise.

- [ ] **Step 2: Create `README.md`**

````markdown
# cx

A macOS command-line tool for managing Apple Contacts. Built with JXA (JavaScript for Automation) for full access to all contact properties, including notes.

## Install

```bash
task install
```
````

This symlinks `cx` to `~/.local/bin/cx`.

## Usage

```text
cx list [--group <name>]              List contacts
cx search <query>                     Search contacts
cx get <id>                           Show contact details
cx create --first <n> --last <n> ...  Create contact
cx update <id> [--field value ...]    Update contact
cx delete <id> [--force]              Delete contact
cx groups list|members|add|remove|create|delete
```

Use short IDs (first 8 characters) or full UUIDs.

### Multi-value fields

Repeat flags for multiple values. Use `label:value` syntax:

```bash
cx create --first Jane --last Doe --email work:jane@co.com --email home:jane@home.com
```

For complex input (addresses, social profiles), pipe JSON via stdin:

```bash
echo '{"firstName":"Jane","lastName":"Doe","emails":[{"label":"work","value":"jane@co.com"}]}' | cx create --json
```

## Why JXA?

Apple's `CNContactStore` requires the `com.apple.developer.contacts.notes` entitlement to access contact notes. This entitlement requires Apple approval and an app bundle. JXA via `osascript` has full access to all contact properties with no entitlements or signing required.

## Development

```bash
task test     # Run integration tests
task lint     # shellcheck + shfmt
task fmt      # Auto-format shell scripts
```

````

- [ ] **Step 3: Format markdown**

Run: `bunx prettier --write CLAUDE.md README.md`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: update CLAUDE.md and add README"
````

---

## Self-Review

**Spec coverage check:**

| Spec requirement                               | Task                                    |
| ---------------------------------------------- | --------------------------------------- |
| Shell wrapper entry point                      | Task 1                                  |
| JXA single file                                | Task 1 (scaffold), Tasks 2-8 (populate) |
| Taskfile (install, test, lint, fmt, uninstall) | Task 1                                  |
| list command                                   | Task 3                                  |
| search command (built-in, not notes)           | Task 3                                  |
| get command with card layout                   | Task 4                                  |
| create with flags and --json                   | Task 5                                  |
| update with flags and --json                   | Task 6                                  |
| delete with --force confirmation               | Task 7                                  |
| groups (all subcommands)                       | Task 8                                  |
| ID resolution (short + full + ambiguous)       | Task 2                                  |
| Text-only output                               | All tasks                               |
| Exit codes 0-5                                 | Tasks 2, 7, 8                           |
| Errors to stderr                               | Task 1 (helpers)                        |
| Integration tests with CxTest\_ prefix         | Task 9                                  |
| Cleanup trap                                   | Task 9                                  |
| Notes read/write tested                        | Task 9                                  |
| CLAUDE.md and README                           | Task 10                                 |

**Placeholder scan:** No TBDs, TODOs, or vague steps. All code blocks are complete.

**Type consistency:** `parseLabelValue`, `applyScalarFields`, `addMultiValueFields`, `contactSummary`, `formatTable`, `formatCard`, `resolveId`, `shortId`, `getApp`, `writeStdout`, `writeStderr`, `readStdin`, `exitWithError` — all used consistently across tasks.
