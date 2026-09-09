# A theory of `cx`

## What this system is for

`cx` exists because of one asymmetry in macOS. The contact records on this machine are the
user's own, but the doors into them are guarded unevenly. The native door,
`CNContactStore`, refuses to hand over the **note** field without the
`com.apple.developer.contacts.notes` entitlement, which requires an app bundle, a signature,
and Apple's approval. The side door — AppleScript's object model, reached through
`osascript -l JavaScript` — has no such lock and needs no signing. `cx` is a refusal to
accept that asymmetry: a personal CLI that treats the scripting bridge as the real
interface and rebuilds a contacts CRUD grammar on top of it.

That origin explains the shape of everything else. There is no domain model of `cx`'s own.
The entities are exactly Contacts' entities — a **person**, a **group**, and the typed
collections hanging off a person (emails, phones, urls, related names, instant messages,
custom dates, addresses, social profiles) — and `cx.js` names them with Contacts'
own property names. What `cx` adds is a *grammar*: a way to say those things in `argv` and
read them back as columns or JSON. Almost every function in the file is doing one of three
jobs, and knowing which job a function has tells you most of what you need about it:
turning flags into a plain record, walking a plain record to drive JXA, or walking a JXA
object into a plain record for rendering.

The note deserves its own sentence, because it is the reason the tool exists and it is
treated differently from every other field. It has no undo, nothing else on the machine
backs it up independently, and `--note` replaces rather than appends. `applyNote` is
therefore the one field writer that is not a loop over a catalogue: it echoes the previous
text to **stderr** before overwriting, and offers `--note-append` as the non-destructive
form. stdout stays clean so a caller parsing output is unaffected. If you take one thing
from this document into a change: the note is the crown jewel, and the stderr echo is a
backup mechanism disguised as a log line.

## The organizing ideas

**One file, and that is the runtime's decision, not a style choice.** JXA has no
`require`, no `import`, no module system at all. `cx.js` is 1,234 lines organized by
section comment (`--- Commands ---`, `--- Selftest ---`) because section comments are the
only structuring device available. A maintainer who "tidies this up" into modules is
fighting `osascript`, not the code. The same constraint is why `cx selftest` ships inside
the production file: there is nowhere else to put a test that must run under the same
interpreter.

**Two catalogues are the single definition of a field.** `SCALARS` and `MULTI`, near the
middle of the file, hold one row per contact field in the order a card renders them. The
argument parser reads them (`multiSpecForFlag`), the writers read them
(`applyScalarFields`, `addMultiValueFields`, `addObjectCollections`), the renderers read
them (`formatCard`), the JSON key aliasing reads them (`jsonKeyToFlag`), and the help text
is *generated* from them (`usage`), which is why `cx help` cannot drift from what the
parser accepts and why `tests/test.sh` asserts on `--birthday` appearing in the usage
output. The pay-off is stated in the comment above `MULTI`: adding a field is one row.
Before the catalogues it was four edits in four places, and missing one gave a field that
parsed but never rendered.

The rows are deliberately sparse, and each absent key means something. No `flag` means
`cx` can render the field but not set it — that is why `name`, `namePrefix` and
`instantMessages` have none. No `display` means the field is rendered somewhere other than
the label column, which is how `note` stays out of the field list and gets its own block at
the bottom of a card. A `json` key names the payload key where it differs from the Contacts
property. `manual: true` on `note` routes it away from the generic setter to `applyNote`.
`guarded: true` on `namePrefix` wraps its read in a try/catch, because reading it throws
`-1700` on some contacts — a fact discovered the hard way and not removable.

**The read/render boundary.** `read*` functions (`readSummary`, `readSummaries`,
`readCard`) touch Contacts and return plain records of strings, arrays and objects.
`format*` functions (`formatTable`, `formatCard`) take those records and return text, and
touch no JXA object ever. Everything below that line is a pure function of plain data. Two
things fall out of it and both are load-bearing. First, `--format json` is a *serialiser*,
not a second renderer: `emit(format, data, renderText)` is one branch at the single point
of output, and the JSON a caller receives is the same record the text formatter consumed.
Second, `cx selftest` can check label parsing, column fitting, date handling and the whole
card layout against literal inputs, with no Contacts.app, no automation permission, and
no contact touched. `task test` runs it first for exactly that reason: a logic regression
fails in milliseconds instead of after two minutes of Apple Events.

**Plural property access is the architecture, not an optimisation.** This is the
non-obvious one. `app.people.id()` is a single Apple Event returning every id in the
address book; a loop calling `person.id()` costs one event per contact. `readSummaries`
therefore makes five plural calls — ids, names, organizations, emails, phones — and pairs
them by index. Measured at 341 contacts that is about 0.7s against about 48s for the
equivalent loop. Earlier versions took 47s for `list` and roughly 10s for anything that
resolved a short id, and the entire performance table in the README is downstream of
switching to this style.

The catch, and it is the kind of thing only measurement finds: plural access works on an
element collection — `app.people`, or a group's `people` — but **not** on a `whose()`
specifier, where it measured 13.3s for 256 names, worse than the loop. That is why
`cmdSearch`, whose input is a `whose()` result, still calls `readSummary` per contact while
`cmdList` and `groupsMembers` call `readSummaries` on a collection. The two functions
produce the same record shape by different means and are not redundant; deleting either one
in the name of removing duplication would cost an order of magnitude somewhere.

Because the index pairing is across five separate events, `readSummaries` refuses rather
than guesses when the arrays come back at different lengths — misaligned arrays would
attribute one person's email to another, which is a silent, plausible-looking corruption of
exactly the sort that never gets noticed.

**Identifiers are dual, and one function owns the duality.** A Contacts UUID looks like
`ABCD1234-…:ABPerson`, which nobody types. `shortId` — the first eight characters — is the
user-facing form, and `resolveId` accepts either, because a full id is a prefix of itself:
one `whose({id: {_beginsWith: idArg}})` query serves both. The invariant is that *every*
command taking a contact id goes through `resolveId` — `cmdGet`, `cmdUpdate`, `cmdDelete`,
`groupsAdd`, `groupsRemove` all do — because a truncated identifier can collide, and
reporting that collision as exit 4 with the candidates listed is part of the contract.
Honouring the invariant is now free; before the prefix query it was a full scan and the
reason `get`/`update`/`delete` all cost ~10s, which is precisely the pressure that would
make someone bypass it.

## Invariants worth naming

- **Every mutation ends in `saveOrFail(app)`.** Without the save the change dies in
  scripting-bridge limbo, and a failed save loses the whole change rather than part of it,
  which is why it is reported as "changes may not have been saved" rather than as a raw JXA
  error. The code is consistent on this across all seven mutating paths.
- **Group membership goes through `app.add(person, {to: group})`.** `group.people.push()`
  throws `-1701`. This is invisible from the code unless you already know.
- **Read a deleted object and JXA throws `-1728`.** `cmdDelete` captures the name, id and
  summary *before* `app.delete`, and the comment beside the emit says so.
- **Dates are date-only values stored at noon local time.** `new Date("1990-05-14")` parses
  as UTC midnight, which is the previous day anywhere west of Greenwich, and Contacts then
  records May 13. `parseDateFlag` builds from local components at noon, which also dodges
  the timezones that skip midnight on a DST transition. Both `--birthday` and
  `--date` go through it; `tests/test.sh` carries the regression.
- **Exit codes are the API.** 0 success, 1 error, 2 permission denied, 3 not found, 4
  ambiguous id, 5 confirmation required. The integration suite asserts on 1, 3, 4 and 5.
  Changing a code is a breaking change for anything scripting `cx`.
- **`--force` is a two-step protocol, not a prompt.** The first call prints what would be
  destroyed and exits 5; the second, with `--force`, performs it. This exists because JXA
  cannot read a tty, and `exitAwaitingConfirmation` deliberately writes to stdout rather
  than stderr — it is not an error condition.
- **Permission failure is probed, not caught.** `Application("Contacts")` is lazy: it
  builds a proxy without contacting anything, so the try/catch that used to wrap it never
  fired. `getApp` forces one cheap real access (`app.name()`) so a TCC refusal surfaces
  where it happens, classified by `isPermissionError` and reported as exit 2, rather than
  as a raw JXA error on whatever the command touched first.

## The seams

Externally there are three, all on the same axis: shell → `cx` (bash) → `osascript` →
Contacts.app. The bash wrapper does exactly one thing beyond `exec`: it resolves symlinks,
so `task install`'s `~/.local/bin/cx` can find `cx.js` beside its real path. The `--` in
`osascript -l JavaScript cx.js -- "$@"` and the matching `pastSeparator` loop in `getArgs`
exist because `osascript` consumes arguments before the separator; that loop is not
defensive coding, it is the only way to see `argv` at all.

Internally there is one seam doing real work, and it is where the theory is thinnest: the
boundary between **flag input** and **`--json` stdin input**. JSON uses Contacts' native
names (`firstName`, `organization`, `jobTitle`, `nameSuffix`); flags use short forms
(`first`, `org`, `title`, `suffix`). `readInput` is the seam. It returns
`{source, fields, positionals}`, both modes normalise into one flag-space `fields` object,
and the rename table is derived from `SCALARS` rather than written out. The mode travels
*beside* the data as `source`, not inside it — carrying it inside as `flags.json` is what
once made `--group` vanish in JSON mode, because `cmdCreate` replaced the whole flags object
with the payload and the flag the user typed was gone before it was read.

The divergence the seam hides is real and is stated rather than smoothed away: **flag input
appends**, unless `--replace <field>` empties the collection first, which is also the only
way to clear one; **JSON input replaces** any collection its payload names. Two sentences,
both true, and a maintainer who "unifies" them will break one of the two workflows.

That said, this is the seam where the theory and the code have drifted furthest apart, and
three of the six findings below live here. The normalisation is not as complete as
`readInput`'s own comment claims: `cmdUpdate` still branches on `source` and drops every
repeatable flag in the JSON branch; only two of six `MULTI` rows carry the `json` key the
collection writers filter on, so a payload naming `urls` or `customDates` is parsed and then
discarded; and the README promises JSON as the way to write addresses and social profiles,
for which no writer exists in any mode. Treat the seam as a partly-finished piece of work,
not as settled design.

## What is easy, what is hard

Easy, and easy in a way that is by design: **adding a contact field**. One row in `SCALARS`
or `MULTI` and the parser, the writers, the card renderer and the help text all pick it up.
Do not add a case to a consumer; if you find yourself wanting to, the row is missing a key.
Also easy: a new `groups` subcommand (one case in `cmdGroups` plus a function); a new output
column (the table sizes itself to the data, capped so one outlier cannot push it off the
terminal).

Hard, in rough order of how fundamental the rethink would be. **Anything wanting more than
one file** is fighting the runtime. **Anything wanting interactive confirmation** is
fighting the absence of a tty and would replace the two-step `--force` protocol that the
tests and any calling script depend on. **Anything wanting to unit-test code that touches
Contacts** has nowhere to stand — the read/render boundary is what makes half the logic
testable, and everything above it is only reachable through `tests/test.sh` against a real
address book. **Anything wanting to make `cmdSearch` fast** runs into the measured fact that
plural access is worse on a `whose()` specifier, so it would mean fetching everything and
filtering locally, which is a different program. And **replacing JXA with `CNContactStore`**
erases the reason the tool exists.

A maintainer who did not hold this theory would most plausibly cause damage by: bypassing
`resolveId` for speed and losing the ambiguity contract; deleting `readSummary` as a
duplicate of `readSummaries`; removing the `namePrefix` try/catch as dead code; replacing
the two-step `--force` flow with a prompt; unifying the flag and JSON collection paths
without noticing the append/replace asymmetry; or "simplifying" `parseDateFlag` back to
`new Date(str)`.

## Uncertainties

Everything here is inferred from the code, the commit history and the tests. There are no
authors to ask. Specific places I would not trust myself:

- **Exit code 2 has never been observed.** `getApp` classifies `-1743` and `-10004` and
  falls back to a message regex, which is the documented Apple Event code for a refused
  automation request — but nobody has revoked the permission and watched it fire. The
  string-matching fallback in `isPermissionError` suggests the author was not certain
  either.
- **`_beginsWith` is assumed case-insensitive.** The README promises short ids work "either
  case" and `resolveId` relies on the query to deliver that. I did not verify it against
  Contacts, and a case-sensitive `_beginsWith` would make lowercase short ids fail as
  not-found rather than resolving.
- **The default labels in `MULTI`** — `home` for email, phone and url, `friend` for related
  names, `anniversary` for custom dates — are inherited from the first implementation.
  Nothing asserts on them, so whether they match what the author wants is untested.
- **The `formatTable` column caps** (10/34/36/20) are round numbers with no recorded
  derivation. The `fit` helper counts UTF-16 units, so CJK and emoji names misalign; a
  comment says that is accepted for a personal tool rather than fixed, which I read as a
  deliberate limit rather than an oversight.
- **Whether `--replace` alongside `--json` should error or work.** Today it silently does
  nothing. I filed that as a defect because the code comment claims flags still apply, but
  it is equally defensible that JSON mode was meant to be exclusive; the fix depends on
  which the author intends.

Two things count as evidence *for* the theory rather than against it. The gotchas
memorialised in `CLAUDE.md` — `namePrefix`, `app.add` versus `push`, the save, the label
wrapping, plural access, short ids — are exactly the load-bearing facts the code enforces,
so author and code agree about where the dangerous edges are. And the previous edition of
this document recorded two claims it had gotten wrong: that fixing the short-id scan
required caching and therefore a state file ("a different program"), and that structured
output "means touching every formatter". Both were inferred from the code rather than
measured, and both fell to a single change — one `whose()` prefix query, and one
read/render split. That correction is the most useful thing in the history of this file.
Measure before you declare something structural.

## Index

| #   | Severity | Issue                                                    | Primary location                              |
| --- | -------- | -------------------------------------------------------- | --------------------------------------------- |
| 1   | medium   | `json-input-ignores-url-related-and-date-collections`     | `cx.js:950-963`, `MULTI`                      |
| 2   | medium   | `docs-claim-json-writes-addresses-and-social-profiles`    | `README.md:47-53`, `cx.js:375-395`            |
| 3   | medium   | `format-validated-after-mutation-in-create-and-update`    | `cx.js:1061`, `cx.js:1084`                    |
| 4   | medium   | `flag-multi-values-dropped-in-json-update`                | `cx.js:594`, `cx.js:1076-1081`                |
| 5   | medium   | `create-pushes-person-before-json-payload-is-validated`   | `cx.js:54-79`, `cx.js:1051-1056`              |
| 6   | low      | `label-detection-uses-a-closed-scheme-list`               | `cx.js:857-877`                               |

**Total: 6 issues (0 critical, 0 high, 5 medium, 1 low)**

Findings live in `.issues/`, which is globally ignored and does not ship.
