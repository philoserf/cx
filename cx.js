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
