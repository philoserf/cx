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
custom dates, addresses, social profiles) — and `cx.js` names them with Contacts' own
property names. What `cx` adds is a _grammar_: a way to say those things in `argv` and read
them back as columns or JSON. Almost every function in the file is doing one of three jobs,
and knowing which job a function has tells you most of what you need about it: turning
input into a plain record, walking a plain record to drive JXA, or walking a JXA object
into a plain record for rendering.

That sentence was written as a description of a tendency. It is now literally the file's
structure, and the section banners say so. Everything above `// --- Contacts access ---`
takes plain data and returns plain data; everything below it talks to Contacts.app. If you
are ever unsure whether a function may touch a `person`, its position answers you.

The note deserves its own sentence, because it is the reason the tool exists and it is
treated differently from every other field. It has no undo, nothing else on the machine
backs it up independently, and a replacement is destructive. `applyNote` is therefore the
one field writer that is not a loop over a catalogue: it echoes the previous text to
**stderr** before overwriting, and append mode is the non-destructive form. stdout stays
clean so a caller parsing output is unaffected. If you take one thing from this document
into a change: the note is the crown jewel, and the stderr echo is a backup mechanism
disguised as a log line.

## The organizing ideas

**One file, and that is the runtime's decision, not a style choice.** JXA has no `require`,
no `import`, no module system at all. `cx.js` is about 1,480 lines organized by section
comment because section comments are the only structuring device available. A maintainer
who "tidies this up" into modules is fighting `osascript`, not the code. The same
constraint is why `cx selftest` ships inside the production file: there is nowhere else to
put a test that must run under the same interpreter.

The four banners are not topical groupings. They are `Process I/O`, `Pure helpers`,
`Contacts access`, and `Commands and dispatch`, and the third one is load-bearing — it is
the read/render boundary made positional. An earlier arrangement grouped by subject
(`--- Contacts.app helpers ---` covered a third of the file, most of which touched nothing),
and the cost was that "does this touch Contacts?" could only be answered by reading each
body. That question is the one the architecture turns on, so it is the one the layout
answers.

**Two catalogues are the single definition of a field.** `SCALARS` and `MULTI` hold one row
per contact field in the order a card renders them. The argument parser reads them, the
writers read them, the renderers read them, the payload key resolution reads them, the
per-command flag allowlist is _derived_ from them, and the help text is _generated_ from
them — which is why `cx help` cannot drift from what the parser accepts, and why
`tests/test.sh` asserts on `--birthday` appearing in the usage output. The pay-off is
stated in the comment above `MULTI`: adding a field is one row. Before the catalogues it
was four edits in four places, and missing one gave a field that parsed but never rendered.

The rows are deliberately sparse, and each absent key means something. No `flag` means `cx`
can render the field but not set it — that is why `name` and `namePrefix` have none. No
`display` means the field is rendered somewhere other than the label column, which is how
`note` stays out of the field list and gets its own block at the bottom of a card.
`manual: true` on `note` routes it away from the generic setter to `applyNote`.
`guarded: true` on `namePrefix` wraps its read in a try/catch, because reading it throws
`-1700` on some contacts — a fact discovered the hard way and not removable.

Two keys carry more weight than they look. A `json` key names the payload key where it
differs from the Contacts property, and it is a **`SCALARS` concept only** — exactly one
row needs it, because `suffix` is `nameSuffix` in a payload. A collection's payload key is
always its `coll`, with no second name to keep in sync. And on `MULTI`, **`ctor` is the
writable test**: it holds the Contacts constructor, it is present on every row `cx` can
build, and it is absent on exactly one, `instantMessages`, which Contacts holds but `cx`
has no way to construct. Writers filter on `spec.ctor`, so read-only-ness is a property of
the row rather than a case in a consumer. This is worth stating because the previous
arrangement used the presence of a `json` key as that filter, and since only two rows
carried one, four writable collections were parsed and then silently discarded. The lesson
generalises: when a catalogue key is used as a filter, make sure it is the key that
actually means what the filter is asking.

**One change record, and both input dialects normalise into it.** This is the write side's
organizing idea and the newest of them. `buildChange` takes the parsed flags and the parsed
stdin payload — both plain data — and returns one record:

    { scalars:     { firstName, birthDate: <Date> },   // keyed by spec.prop
      note:        { mode: "replace" | "append", text },
      collections: { emails: { mode: "append" | "replace", items: [{label, value}] } },
      group, format }

Four things are true of it, and each was false before. It is keyed by Contacts property
name, so there is one key space — flag input and payload input used to land in two disjoint
ones (`email` versus `emails`) with four separate writers and a `source` field carried down
from the reader so `cmdUpdate` could pick a pipeline and drop the other one's input. Its
dates are `Date` objects, so parsing is done rather than deferred. Its `mode` carries the
dialect difference as _data_: a repeated flag appends, a payload names a collection
wholesale and replaces it, and merging the key spaces deliberately did not merge those
semantics. And normalisation _is_ validation — every rejection happens in `buildChange`,
which touches nothing.

The distinction to hold on to: the two key spaces were an accident and are gone; the two
_semantics_ are a design decision and remain. A maintainer who unifies append and replace
because "the record already merged them" will break one of two workflows.

**The read/render boundary, and its write-side counterpart.** `read*` functions touch
Contacts and return plain records of strings, arrays and objects. `format*` functions take
those records and return text, and touch no JXA object ever. Two things fall out and both
are load-bearing. First, `--format json` is a _serialiser_, not a second renderer: `emit`
is one branch at the single point of output, and the JSON a caller receives is the same
record the text formatter consumed. Second, `cx selftest` can check label parsing, column
fitting, date handling and the whole card layout against literal inputs, with no
Contacts.app, no automation permission, and no contact touched.

For a long time that boundary had no counterpart on the write side, and the consequence was
concrete: there was no function anywhere that took `argv` and returned _what would be
written_. The decision and the write were the same statements inside the command bodies, so
every write-path defect could only be confirmed by creating a real contact in somebody's
address book. `buildChange` is that counterpart. The selftest now covers the whole
flag-and-payload mapping — every rejection, every mode, every date, in both dialects — in
milliseconds. If you are adding behaviour to the write path and you cannot see how to test
it in `cx selftest`, that is a signal the logic has leaked below the boundary.

**Input is closed, not open.** `parseArgs` takes a per-command allowlist derived from the
catalogues, and a flag a command does not read is an error. So is a payload key that
matches nothing, and so is an update naming no field at all. This is a recent and
deliberate inversion: the parser used to accept any `--word value` pair and store it, which
meant `cx update <id> --nte "text"` printed `Updated <name>`, exited 0, and wrote nothing.
For a tool whose reason to exist is a field with no undo, a silent no-op reported as
success is the worst available outcome — the user believes the text is stored and stops
keeping the source.

The shape of the rule matters as much as the rule. The allowlist is _per command_ because
the commands genuinely differ: only `create` and `update` take `--json`, only `update` takes
`--replace`, and `--group` means a destination on `create` but a filter on `list`. It is
derived from `SCALARS` and `MULTI` rather than written out, so it cannot drift from the
parser or the help text. And the effect on the test suite is visible: rejection assertions
went from seven to twenty-one, which is the suite's centre of gravity moving from "does it
write correctly" to "does it refuse correctly".

**Plural property access is the architecture, not an optimisation.** This is the non-obvious
one. `app.people.id()` is a single Apple Event returning every id in the address book; a
loop calling `person.id()` costs one event per contact. `readSummaries` therefore makes five
plural calls — ids, names, organizations, emails, phones — and pairs them by index.
Measured at a few hundred contacts that is about 0.7s against about 48s for the equivalent
loop. Earlier versions took 47s for `list` and roughly 10s for anything that resolved a
short id, and the entire performance table in the README is downstream of switching to this
style.

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
one `whose({id: {_beginsWith: idArg}})` query serves both, and it is case-insensitive
(verified against Contacts, not assumed). The invariant is that _every_ command taking a
contact id goes through `resolveId`, because a truncated identifier can collide, and
reporting that collision as exit 4 with the candidates listed is part of the contract.
Honouring the invariant is now free; before the prefix query it was a full scan and the
reason `get`/`update`/`delete` all cost ~10s, which is precisely the pressure that would
make someone bypass it.

One consequence is easy to miss and matters for anything automated: `--force` plus a short
id is the one combination where an ambiguity is both possible and silenced. The test
harness's cleanup sweep deletes by **full** id for exactly this reason — its `|| true`
would swallow an exit 4 and leave the contact it was there to remove.

## Invariants worth naming

- **A mutation goes live in the running app as it is made; `save` is what persists it to
  disk.** This was measured, because it decides whether the ordering rules below are
  correctness machinery or tidiness: push a person and exit without saving, and a _separate
  process_ finds the contact; quit Contacts.app and it is gone. Neither "an unsaved change
  persists" nor "an unsaved change is lost" is true on its own, and for a while this
  repository asserted both, in different files, without flagging it (issue #13). The
  practical consequence: a failure between the
  push and the save strands a real, findable, half-built contact for the life of the
  Contacts process, which on a normal Mac means until reboot.
- **Nothing that can fail may run after `app.people.push`.** This follows from the previous
  point and is now structural rather than aspirational: `applyScalars`, `applyNote`,
  `applyCollections` and `clearCollection` contain no `exitWithError` between them, and
  everything that can reject moved up into `buildChange`, which runs before `getApp()`.
  `cmdCreate` additionally sets `organization` in the constructor properties rather than
  waiting for `applyScalars`, because an org-only record has no personal name and would
  otherwise be momentarily nameless _and_ organization-less — invisible to every search,
  including the harness sweeping up after an interrupted run.
- **Every mutation ends in `saveOrFail(app)`.** A failed save loses the whole change rather
  than part of it, which is why it is reported as "changes may not have been saved" rather
  than as a raw JXA error.
- **Contacts validates nothing, so `cx` is the only validator.** `--email "work:))))"` is
  accepted and stored; so is a url that is not a url. This is deliberate scope — `cx` is a
  grammar over Contacts, not a schema for it — but it has a sharp edge: `cx` type-checks
  (a payload value must be a string, an items list must be an array) and it value-checks
  exactly one thing, dates. Do not assume a write that succeeded was inspected by anything.
- **Group membership goes through `app.add(person, {to: group})`.** `group.people.push()`
  throws `-1701`. This is invisible from the code unless you already know.
- **Read a deleted object and JXA throws `-1728`.** `cmdDelete` captures the name, id and
  summary _before_ `app.delete`, and the comment beside the emit says so.
- **Dates are date-only values stored at noon local time.** `new Date("1990-05-14")` parses
  as UTC midnight, which is the previous day anywhere west of Greenwich, and Contacts then
  records May 13. `parseDateFlag` builds from local components at noon, which also dodges
  the timezones that skip midnight on a DST transition. Both dialects go through it — a
  payload `customDates` value is parsed exactly as a `--date` flag is — and `tests/test.sh`
  carries the regression.
- **Exit codes are the API.** 0 success, 1 error, 2 permission denied, 3 not found, 4
  ambiguous id, 5 confirmation required. Changing which input produces which code is a
  breaking change for anything scripting `cx`, independently of whether the text moved.
- **`--force` is a two-step protocol, not a prompt.** The first call prints what would be
  destroyed and exits 5; the second, with `--force`, performs it. This exists because JXA
  cannot read a tty, and `exitAwaitingConfirmation` deliberately writes to stdout rather
  than stderr — it is not an error condition.
- **Permission failure is probed, not caught.** `Application("Contacts")` is lazy: it builds
  a proxy without contacting anything, so a try/catch around it never fires. `getApp` forces
  one cheap real access so a TCC refusal surfaces where it happens, classified by
  `isPermissionError` and reported as exit 2.

## The seams

Externally there are three, all on the same axis: shell → `cx` (bash) → `osascript` →
Contacts.app. The bash wrapper does exactly one thing beyond `exec`: it resolves symlinks,
so `task install`'s `~/.local/bin/cx` can find `cx.js` beside its real path. The `--` in
`osascript -l JavaScript cx.js -- "$@"` and the matching `pastSeparator` loop in `getArgs`
exist because `osascript` consumes arguments before the separator; that loop is not
defensive coding, it is the only way to see `argv` at all.

Internally, the seam that used to be the thinnest part of this theory is now the most
worked-out part of it, and the reversal is worth understanding because it is the largest
single change the system has been through.

The seam is the boundary between **flag input** and **`--json` stdin input**. Flags use
short forms (`first`, `org`, `title`); a payload uses Contacts' native names (`firstName`,
`organization`, `jobTitle`). The previous arrangement normalised those into one _flag-space_
object and carried the mode beside it as `source`, and the theory's claim was that after the
seam nothing downstream needed to know which dialect had arrived. That claim was false in
practice and in three separate ways at once — `cmdUpdate` branched on `source` and dropped
every repeatable flag in the payload branch, four of six collections were filtered out by a
key only two rows carried, and the payload side had no validation pass at all.

What replaced it inverts the normalisation. Both dialects now resolve into the _Contacts
property_ space rather than the flag space, which is the space everything downstream already
used, and the mode became a per-collection field of the record rather than a flag beside it.
`readInput` shrank to a three-line shell around `buildChange`: read argv, read stdin,
normalise. The split is deliberate — `readInput` touches stdin and can never be selftested,
so the logic lives next door where it can be.

The divergence the seam hides is real and is still stated rather than smoothed away: **flag
input appends**, unless `--replace <field>` empties the collection first, which is also the
only way to clear one; **payload input replaces** any collection it names. Where both name
the same collection, replace wins and both sets of values land in it.

The thinnest place now is elsewhere, and it is smaller. `readCard` decides whether a
collection value is a date two different ways — the scalar loop asks the catalogue
(`spec.type === "date"`), the collection loop duck-types the runtime object via
`formatValue`. Both give the same answer for the six rows that exist, so nothing is broken;
what is broken is the principle, in the one file whose stated premise is that the catalogue
is the single definition. That is issue #25. Related in kind: `parseLabelValue` decides
label-versus-URI from a hard-coded list of four schemes, so `--url ssh://host` stores
`//host` under a label named `ssh`. The rule it is reaching for is "a colon that starts a
URI scheme is not a separator"; what it has is the four schemes someone needed. That is
issue #29.

One genuinely unresolved boundary remains, and it is a Contacts limitation rather than a
`cx` one. Addresses and social profiles are rendered but not writable, because a Contacts
address is a record of street, city, state, zip and country and a social profile is
service, username and url — neither fits the `{label, value}` pair every writable collection
assumes. `cx` now refuses a payload naming them by name rather than dropping it, which is
honest, but the asymmetry is real: `cx get` shows you things `cx update` cannot change.

## What is easy, what is hard

Easy, and easy in a way that is by design: **adding a contact field**. One row in `SCALARS`
or `MULTI` and the parser, the flag allowlist, the writers, the card renderer and the help
text all pick it up. Do not add a case to a consumer; if you find yourself wanting to, the
row is missing a key. Also easy: a new `groups` subcommand (one case plus a function); a new
output column (the table sizes itself to the data, capped so one outlier cannot push it off
the terminal); and — newly — **changing what input is accepted or rejected**, which is one
function, pure, and covered by the selftest.

Hard, in rough order of how fundamental the rethink would be. **Anything wanting more than
one file** is fighting the runtime. **Anything wanting interactive confirmation** is
fighting the absence of a tty and would replace the two-step `--force` protocol that the
tests and any calling script depend on. **Anything wanting to make `cmdSearch` fast** runs
into the measured fact that plural access is worse on a `whose()` specifier, so it would
mean fetching everything and filtering locally, which is a different program — and note that
widening what `search` matches (issue #11) is the same problem, since the current four-way
`_or` is the whole search surface and the note is precisely what it cannot reach. And
**replacing JXA with `CNContactStore`** erases the reason the tool exists.

One item moved off this list and it is worth saying why. "Anything wanting to unit-test code
that touches Contacts has nowhere to stand" used to be true of the entire write path. Half
of it is now false: the decision about what to write is a pure function and is tested as
one. What remains true is the other half — the code that drives JXA once the decision is
made is still only reachable through `tests/test.sh` against a real address book, which is
why that harness cleans up by prefix rather than by a list it built as it went, and why its
cleanup guards are load-bearing rather than defensive.

A maintainer who did not hold this theory would most plausibly cause damage by: bypassing
`resolveId` for speed and losing the ambiguity contract; deleting `readSummary` as a
duplicate of `readSummaries`; removing the `namePrefix` try/catch as dead code; replacing
the two-step `--force` flow with a prompt; unifying append and replace because the record
already merged the key spaces; moving a rejection out of `buildChange` and below `getApp()`;
or "simplifying" `parseDateFlag` back to `new Date(str)`.

## Uncertainties

Everything here is inferred from the code, the commit history, the tests and a handful of
direct measurements. There are no authors to ask. Specific places I would not trust myself:

- **Exit code 2 has never been observed.** `getApp` classifies `-1743` and `-10004` and
  falls back to a message regex, which is the documented Apple Event code for a refused
  automation request — but nobody has revoked the permission and watched it fire. The
  string-matching fallback suggests the author was not certain either.
- **The default labels in `MULTI`** — `home` for email, phone and url, `friend` for related
  names, `anniversary` for custom dates — are inherited from the first implementation.
  Nothing asserts on them, so whether they match what the author wants is untested.
- **The `formatTable` column caps** (10/34/36/20) are round numbers with no recorded
  derivation. The `fit` helper counts UTF-16 units, so CJK and emoji names misalign; a
  comment says that is accepted for a personal tool rather than fixed, which I read as a
  deliberate limit rather than an oversight.
- **Where flag items should land when a payload replaces the same collection.** The record
  puts payload items first and flag items after. Nothing depends on that order and nothing
  asserts it beyond one selftest case that pins current behaviour; Contacts displays a
  collection in insertion order, so it is user-visible but arbitrary. I chose it; I cannot
  tell you the author would have.
- **Whether refusing a read-only payload key is right, or merely defensible.** `cx` now
  errors on `addresses`, `name` and the `cx get` envelope rather than ignoring them. That
  makes a round-trip fail loudly instead of silently, which I believe is correct for a tool
  with no undo — but it also means a caller who assembles a payload by deleting keys from a
  `cx get` record gets an error rather than a partial write, and someone might reasonably
  have wanted the partial write.

Two things count as evidence _for_ the theory rather than against it. The gotchas
memorialised in `CLAUDE.md` — `namePrefix`, `app.add` versus `push`, the label wrapping,
plural access, short ids — are exactly the load-bearing facts the code enforces, so author
and code agree about where the dangerous edges are.

And the history of this document is itself the most useful thing in it. Its first edition
recorded two claims it had gotten wrong: that fixing the short-id scan required caching and
therefore a state file ("a different program"), and that structured output "means touching
every formatter". Both were inferred from the code rather than measured, and both fell to a
single change. Its second edition then called the flag/JSON seam "a partly-finished piece of
work" and listed three defects there — and that diagnosis was right, but it under-read the
cause: the three defects were one defect, and naming it dissolved nine open findings at
once. The pattern repeats. **Measure before you declare something structural, and when you
find three bugs in one place, look for the one bug underneath them.**

## Loose ends

Open questions this theory points at, tracked as issues rather than restated here:

- **#25** — `readCard` decides "is this a date" two ways, one of which ignores the
  catalogue. The clearest live counter-example to the single-definition premise.
- **#29** — `parseLabelValue`'s four-scheme allowlist, the only ambiguous grammar `cx`
  accepts and the one place it is resolved by a list rather than a rule.
- **#11** — the search surface is four name and organization properties, so the note, the
  field the tool exists for, is the one thing that cannot be searched.
- **#34** — `cmdSelftest` is 215 of ~1,480 lines sitting between dispatch and the command
  bodies, the one place the file resists being read straight through.
