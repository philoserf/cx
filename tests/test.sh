#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CX="$SCRIPT_DIR/../cx"
PASS=0
FAIL=0
# The trailing underscore matters: the sweep matches with _contains, so a
# bare pid prefix would also match a longer pid's run -- CxTest_1045 would
# sweep a concurrent CxTest_10450 suite's contacts out from under it.
TEST_PREFIX="CxTest_${$}_"

# Cleanup asks Contacts what exists under our prefix rather than replaying a
# list built as we went. Registering an ID after the create that produced it
# leaves a window -- a failed extraction aborts the script under set -e with
# nothing registered -- and a create that fails never returns an ID at all.
# The prefix is known before the first create, so it cannot be outrun.
#
# Every sweep is wrapped in `|| true`, and that is load-bearing rather than
# defensive: under set -e a failing command inside an EXIT trap aborts the rest
# of the trap, so an unguarded contact sweep would skip the groups entirely.
cleanup() {
	local status=$?
	echo ""
	echo "--- Cleanup ---"
	# Delete by full id, never the short one: resolveId matches on a prefix and
	# exits 4 when it is ambiguous, which `|| true` would swallow -- silently
	# leaking the contact this sweep exists to remove.
	{
		"$CX" search "$TEST_PREFIX" --format json |
			/usr/bin/jq -r '.[].id' |
			while read -r id; do
				"$CX" delete "$id" --force 2>/dev/null || true
			done
	} || true
	# groups list emits a bare array of names, so the prefix match is ours to
	# make; read a whole line, since a group name may contain spaces.
	{
		"$CX" groups list --format json |
			/usr/bin/jq -r --arg p "$TEST_PREFIX" '.[] | select(startswith($p))' |
			while IFS= read -r group; do
				"$CX" groups delete "$group" --force 2>/dev/null || true
			done
	} || true
	# Say so rather than exiting quietly: a sweep that could not run is the
	# failure this whole mechanism exists to prevent.
	local left
	left=$("$CX" search "$TEST_PREFIX" --format json 2>/dev/null |
		/usr/bin/jq -r "length" 2>/dev/null) || left=""
	if [[ "${left:-0}" != "0" ]]; then
		echo "  WARNING: ${left:-?} contact(s) matching $TEST_PREFIX remain"
	fi
	return $status
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
		PASS=$((PASS + 1))
	else
		echo "  FAIL: exit $actual (expected $expected): $*"
		FAIL=$((FAIL + 1))
	fi
}

assert_contains() {
	local expected="$1"
	local output="$2"
	if echo "$output" | grep -q -- "$expected"; then
		echo "  PASS: output contains '$expected'"
		PASS=$((PASS + 1))
	else
		echo "  FAIL: output missing '$expected'"
		echo "  Got: $output"
		FAIL=$((FAIL + 1))
	fi
}

assert_not_contains() {
	local expected="$1"
	local output="$2"
	if echo "$output" | grep -q -- "$expected"; then
		echo "  FAIL: output should not contain '$expected'"
		FAIL=$((FAIL + 1))
	else
		echo "  PASS: output does not contain '$expected'"
		PASS=$((PASS + 1))
	fi
}

assert_json() {
	local output="$1"
	if echo "$output" | json_pp >/dev/null 2>&1; then
		echo "  PASS: output is valid JSON"
		PASS=$((PASS + 1))
	else
		echo "  FAIL: output is not valid JSON"
		echo "  Got: $output"
		FAIL=$((FAIL + 1))
	fi
}

# --- Test: usage ---
echo "=== Usage ==="
output=$("$CX" 2>&1 || true)
assert_contains "Usage:" "$output"
# Generated from the field catalogues, so it cannot drift from the parser.
assert_contains "\-\-birthday" "$output"
assert_contains "\-\-replace" "$output"
assert_contains "\-\-format json" "$output"

output=$("$CX" --version 2>&1)
assert_contains "cx " "$output"

# --- Test: create ---
echo ""
echo "=== Create ==="
output=$("$CX" create --first "${TEST_PREFIX}" --last "Person" --note "test note from cx" --email "work:${TEST_PREFIX}@example.com" --phone "mobile:555-0199" --format json 2>&1)
echo "$output"
assert_json "$output"
assert_contains '"action": "created"' "$output"

# Extract short ID
CONTACT_ID=$(echo "$output" | /usr/bin/jq -r .shortId)
echo "  Contact ID: $CONTACT_ID"

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
assert_contains "555-0199" "$output"

# --- Test: update ---
echo ""
echo "=== Update ==="
# The only coverage of emitAction's text output: every create in this suite
# now runs --format json so the id can be read without parsing a rendered line.
output=$("$CX" update "$CONTACT_ID" --note "updated note from cx" 2>&1)
assert_contains "Updated" "$output"
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
GROUP_NAME="${TEST_PREFIX}Group"

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

# --- Test: delete with --force ---
echo ""
echo "=== Delete (force) ==="
"$CX" delete "$CONTACT_ID" --force

output=$("$CX" search "${TEST_PREFIX}" 2>&1)
assert_not_contains "${TEST_PREFIX}" "$output"

# --- Test: create via JSON ---
echo ""
echo "=== Create (JSON) ==="
JSON_PREFIX="${TEST_PREFIX}J"
output=$(printf '{"firstName":"%s","lastName":"Person","note":"json note from cx","jobTitle":"Drafter","emails":[{"label":"work","value":"%s@example.com"}],"phones":[{"label":"mobile","value":"555-0142"}]}' "$JSON_PREFIX" "$JSON_PREFIX" | "$CX" create --json --format json 2>&1)
echo "$output"
assert_json "$output"
assert_contains '"action": "created"' "$output"

JSON_ID=$(echo "$output" | /usr/bin/jq -r .shortId)
echo "  Contact ID: $JSON_ID"

output=$("$CX" get "$JSON_ID" 2>&1)
assert_contains "json note from cx" "$output"
assert_contains "Drafter" "$output"
assert_contains "${JSON_PREFIX}@example.com" "$output"
assert_contains "555-0142" "$output"

# --- Test: update via JSON ---
echo ""
echo "=== Update (JSON) ==="
printf '{"note":"json updated note","department":"Verification","emails":[{"label":"home","value":"%s-home@example.com"}]}' "$JSON_PREFIX" | "$CX" update "$JSON_ID" --json
output=$("$CX" get "$JSON_ID" 2>&1)
assert_contains "json updated note" "$output"
assert_contains "Verification" "$output"

# JSON update replaces any collection its payload names, as of E3. It used to
# ignore collections entirely, because cmdUpdate skipped addMultiValueFields
# whenever the input was JSON.
assert_contains "${JSON_PREFIX}-home@example.com" "$output"

# urls, relatedNames and customDates reach Contacts now. Their MULTI rows had
# no json key, and both JSON writers filtered on that key, so a payload naming
# them was parsed and then silently discarded.
printf '{"urls":[{"label":"homepage","value":"https://example.com/%s"}],"relatedNames":[{"label":"friend","value":"Ada L"}],"customDates":[{"label":"anniversary","value":"2011-07-08"}]}' "$JSON_PREFIX" | "$CX" update "$JSON_ID" --json
output=$("$CX" get "$JSON_ID" 2>&1)
assert_contains "https://example.com/${JSON_PREFIX}" "$output"
assert_contains "Ada L" "$output"
assert_contains "2011-07-08" "$output"

# A repeatable flag alongside --json used to be dropped: cmdUpdate branched on
# which dialect the input arrived in and ran only that pipeline.
printf '{"note":"both dialects"}' | "$CX" update "$JSON_ID" --json --phone "work:555-0111"
output=$("$CX" get "$JSON_ID" 2>&1)
assert_contains "both dialects" "$output"
assert_contains "555-0111" "$output"

# --- Test: list ---
# The only coverage of cmdList. Slow (~70s on a real address book) until the
# bulk-fetch work in commit E1 lands.
echo ""
echo "=== List ==="
output=$("$CX" list 2>&1)
assert_contains "${JSON_PREFIX}" "$output"

# --- Test: create with --group ---
echo ""
echo "=== Create (--group) ==="
CGROUP_NAME="${TEST_PREFIX}CGroup"
"$CX" groups create "$CGROUP_NAME"

FLAG_PREFIX="${TEST_PREFIX}F"
output=$("$CX" create --first "${FLAG_PREFIX}" --last "Person" --group "$CGROUP_NAME" 2>&1)
echo "$output"
assert_contains "Created" "$output"

output=$("$CX" groups members "$CGROUP_NAME" 2>&1)
assert_contains "${FLAG_PREFIX}" "$output"

# --group survives JSON mode as of D1. It used to be dropped: cmdCreate
# replaced the parsed flags with the JSON payload before reading flags.group,
# so the flag the user typed was gone by the time it was read.
JGROUP_PREFIX="${TEST_PREFIX}JG"
output=$(printf '{"firstName":"%s","lastName":"Person"}' "$JGROUP_PREFIX" | "$CX" create --json --group "$CGROUP_NAME" 2>&1)
echo "$output"
assert_contains "Created" "$output"

output=$("$CX" groups members "$CGROUP_NAME" 2>&1)
assert_contains "${JGROUP_PREFIX}" "$output"

# --- Test: multi-value fields ---
# All five repeatable fields in one create. Only emails and phones were
# covered before, which left url, related and date unexercised.
echo ""
echo "=== Multi-value fields ==="
MULTI_PREFIX="${TEST_PREFIX}M"
output=$("$CX" create --first "${MULTI_PREFIX}" --last "Person" --email "work:${MULTI_PREFIX}@example.com" --phone "mobile:555-0175" --url "homepage:https://example.com/${MULTI_PREFIX}" --related "friend:Some Friend" --date "anniversary:2011-07-08" --format json 2>&1)
echo "$output"
MULTI_ID=$(echo "$output" | /usr/bin/jq -r .shortId)

output=$("$CX" get "$MULTI_ID" 2>&1)
assert_contains "${MULTI_PREFIX}@example.com" "$output"
assert_contains "555-0175" "$output"
assert_contains "https://example.com/${MULTI_PREFIX}" "$output"
assert_contains "Some Friend" "$output"
assert_contains "2011-07-08" "$output"

# --- Test: dates ---
# Regression for the timezone defect: a birthday entered as 1990-05-14 was
# stored as 1990-05-13 in any negative UTC offset, because new Date() parses a
# date-only string as UTC midnight. --date took a raw string where --birthday
# took a Date; both now parse identically.
echo ""
echo "=== Dates ==="
DATE_PREFIX="${TEST_PREFIX}D"
output=$("$CX" create --first "${DATE_PREFIX}" --last "Person" --birthday 1990-05-14 --date "anniversary:2000-01-02" --format json 2>&1)
echo "$output"
DATE_ID=$(echo "$output" | /usr/bin/jq -r .shortId)

output=$("$CX" get "$DATE_ID" 2>&1)
assert_contains "1990-05-14" "$output"
assert_contains "2000-01-02" "$output"

assert_exit 1 "$CX" create --first "${DATE_PREFIX}bad" --birthday "14 May 1990"
assert_exit 1 "$CX" create --first "${DATE_PREFIX}bad" --birthday "2026-02-30"

# Before C3 these two rejected creates pushed the contact first and parsed the
# date after, leaving CxTest_<pid>Dbad orphans that no cleanup tracked, because
# a failed create never returns an ID to track.
output=$("$CX" search "${DATE_PREFIX}bad" 2>&1)
assert_not_contains "${DATE_PREFIX}bad" "$output"

# --- Test: create validation ---
# cmdCreate used to push the person into the store before resolving the group
# or parsing dates, so a failure left a half-built contact behind.
echo ""
echo "=== Create (validation) ==="
VAL_PREFIX="${TEST_PREFIX}V"

assert_exit 3 "$CX" create --first "${VAL_PREFIX}" --last "Person" --group "NoSuchGroup_${TEST_PREFIX}"
output=$("$CX" search "${VAL_PREFIX}" 2>&1)
assert_not_contains "${VAL_PREFIX}" "$output"

assert_exit 1 "$CX" create --first "${VAL_PREFIX}" --last "Person" --birthday "not-a-date"
output=$("$CX" search "${VAL_PREFIX}" 2>&1)
assert_not_contains "${VAL_PREFIX}" "$output"

# --- Test: flag before positional ---
# `cx delete --force <id>` used to read --force as the contact ID and exit 3.
echo ""
echo "=== Flag before positional ==="
ORDER_PREFIX="${TEST_PREFIX}O"
output=$("$CX" create --first "${ORDER_PREFIX}" --last "Person" --format json 2>&1)
ORDER_ID=$(echo "$output" | /usr/bin/jq -r .shortId)

"$CX" delete --force "$ORDER_ID"
output=$("$CX" search "${ORDER_PREFIX}" 2>&1)
assert_not_contains "${ORDER_PREFIX}" "$output"

# --- Test: note protection ---
echo ""
echo "=== Note protection ==="
NOTE_PREFIX="${TEST_PREFIX}N"
output=$("$CX" create --first "${NOTE_PREFIX}" --last "Person" --note "original note" --format json 2>&1)
NOTE_ID=$(echo "$output" | /usr/bin/jq -r .shortId)

# The replaced note goes to stderr, never stdout.
output=$("$CX" update "$NOTE_ID" --note "replacement note" 2>/dev/null)
assert_not_contains "original note" "$output"
output=$("$CX" update "$NOTE_ID" --note "second note" 2>&1 >/dev/null)
assert_contains "replacement note" "$output"

"$CX" update "$NOTE_ID" --note-append "appended line"
output=$("$CX" get "$NOTE_ID" 2>&1)
assert_contains "second note" "$output"
assert_contains "appended line" "$output"

# --- Test: replace and clear ---
echo ""
echo "=== Replace ==="
REP_PREFIX="${TEST_PREFIX}R"
output=$("$CX" create --first "${REP_PREFIX}" --last "Person" --email "work:${REP_PREFIX}a@example.com" --email "home:${REP_PREFIX}b@example.com" --format json 2>&1)
REP_ID=$(echo "$output" | /usr/bin/jq -r .shortId)

"$CX" update "$REP_ID" --replace email --email "work:${REP_PREFIX}c@example.com"
output=$("$CX" get "$REP_ID" 2>&1)
assert_contains "${REP_PREFIX}c@example.com" "$output"
assert_not_contains "${REP_PREFIX}a@example.com" "$output"

# --replace with nothing to add is how a collection is cleared
"$CX" update "$REP_ID" --replace email
output=$("$CX" get "$REP_ID" 2>&1)
assert_not_contains "${REP_PREFIX}c@example.com" "$output"

# A rejected --replace must not have written the scalars and the note first.
"$CX" update "$REP_ID" --note "guard note" --org "Guard Co" >/dev/null
assert_exit 1 "$CX" update "$REP_ID" --note "clobbered" --replace bogusfield
output=$("$CX" get "$REP_ID" 2>&1)
assert_contains "guard note" "$output"
assert_not_contains "clobbered" "$output"

# The README teaches the plural payload spelling, so --replace accepts it.
"$CX" update "$REP_ID" --replace emails --email "work:${REP_PREFIX}d@example.com"
output=$("$CX" get "$REP_ID" 2>&1)
assert_contains "${REP_PREFIX}d@example.com" "$output"

# --- Test: company contact ---
# Contacts models a business as a company-flagged record with no personal
# name. create used to reject it for having neither --first nor --last.
echo ""
echo "=== Company contact ==="
ORG_PREFIX="${TEST_PREFIX}Co"
output=$("$CX" create --org "${ORG_PREFIX} Industries" --phone "work:555-0188" --format json 2>&1)
echo "$output"
assert_json "$output"
assert_contains '"action": "created"' "$output"
ORG_ID=$(echo "$output" | /usr/bin/jq -r .shortId)

output=$("$CX" get "$ORG_ID" 2>&1)
assert_contains "${ORG_PREFIX} Industries" "$output"
assert_contains "555-0188" "$output"

# --- Test: json output ---
# Every command takes --format json, so a caller never has to parse columns.
echo ""
echo "=== JSON output ==="
FMT_PREFIX="${TEST_PREFIX}Fmt"
output=$("$CX" create --first "${FMT_PREFIX}" --last "Person" --email "work:${FMT_PREFIX}@example.com" --format json 2>&1)
assert_json "$output"
assert_contains '"action": "created"' "$output"
FMT_ID=$(echo "$output" | /usr/bin/jq -r .shortId)

assert_json "$("$CX" get "$FMT_ID" --format json 2>&1)"
assert_json "$("$CX" search "${FMT_PREFIX}" --format json 2>&1)"
assert_json "$("$CX" list --format json 2>&1)"
assert_json "$("$CX" groups list --format json 2>&1)"

# The confirmation step is structured too, and still exits 5.
output=$("$CX" delete "$FMT_ID" --format json 2>&1 || true)
assert_json "$output"
assert_contains "confirmation-required" "$output"
assert_exit 5 "$CX" delete "$FMT_ID" --format json

assert_exit 1 "$CX" get "$FMT_ID" --format yaml

# --- Test: input validation ---
# All of these exit before getApp(), so the block costs nothing and touches no
# contact. Each one used to be accepted: a misspelled flag wrote nothing and
# reported success, a zero-field update did the same, and a payload naming a
# key cx cannot write was dropped without a word.
echo ""
echo "=== Input validation ==="
VPREFIX="${TEST_PREFIX}Inv"

# Unknown flags, per command.
assert_exit 1 "$CX" get "$JSON_ID" --json
assert_exit 1 "$CX" update "$JSON_ID" --nte "text"
assert_exit 1 "$CX" list --grup Friends
assert_exit 1 "$CX" create --first "$VPREFIX" --replace email
assert_exit 1 "$CX" create --first "$VPREFIX" --bogus 1

# Exit 0 from update now means something actually changed.
assert_exit 1 "$CX" update "$JSON_ID"

# Contradictory rather than silently resolved in the append's favour.
assert_exit 1 "$CX" update "$JSON_ID" --note a --note-append b

# --format is rejected before the write, not after it.
assert_exit 1 "$CX" create --first "$VPREFIX" --format yaml
output=$("$CX" search "$VPREFIX" 2>&1)
assert_not_contains "$VPREFIX" "$output"

# A payload has to be an object, and every key has to be one cx can write.
assert_exit 1 bash -c "echo null    | '$CX' create --json"
assert_exit 1 bash -c "echo '[1,2]' | '$CX' create --json"
assert_exit 1 bash -c "echo 5       | '$CX' create --json"
assert_exit 1 bash -c "echo '{\"firstName\":\"X\",\"nonsense\":1}' | '$CX' create --json"
assert_exit 1 bash -c "echo '{\"firstName\":\"X\",\"addresses\":[]}' | '$CX' create --json"
assert_exit 1 bash -c "echo '{\"firstName\":\"X\",\"emails\":\"a@b.co\"}' | '$CX' create --json"

# The cx get envelope is diagnosed by name rather than accepted and ignored.
output=$("$CX" get "$JSON_ID" --format json | "$CX" update "$JSON_ID" --json 2>&1 || true)
assert_contains "nested record" "$output"

# --- Test: ambiguous ID ---
# Assumes at least two contacts share the leading hex digit of JSON_ID, which
# holds for any non-trivial address book. Exit 3 here would mean the prefix
# matched nothing, which cannot happen since JSON_ID itself starts with it.
echo ""
echo "=== Ambiguous ID ==="
assert_exit 4 "$CX" get "${JSON_ID:0:1}"

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
