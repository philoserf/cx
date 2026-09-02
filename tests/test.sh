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
	# bash 3.2 (stock macOS /bin/bash) errors on "${arr[@]}" for an empty
	# array under set -u, and both arrays are emptied on a successful run.
	if [[ ${#CREATED_IDS[@]} -gt 0 ]]; then
		for id in "${CREATED_IDS[@]}"; do
			"$CX" delete "$id" --force 2>/dev/null || true
		done
	fi
	if [[ ${#CREATED_GROUPS[@]} -gt 0 ]]; then
		for group in "${CREATED_GROUPS[@]}"; do
			"$CX" groups delete "$group" --force 2>/dev/null || true
		done
	fi
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
	if echo "$output" | grep -q "$expected"; then
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
	if echo "$output" | grep -q "$expected"; then
		echo "  FAIL: output should not contain '$expected'"
		FAIL=$((FAIL + 1))
	else
		echo "  PASS: output does not contain '$expected'"
		PASS=$((PASS + 1))
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

# --- Test: create via JSON ---
echo ""
echo "=== Create (JSON) ==="
JSON_PREFIX="${TEST_PREFIX}J"
output=$(printf '{"firstName":"%s","lastName":"Person","note":"json note from cx","jobTitle":"Drafter","emails":[{"label":"work","value":"%s@example.com"}],"phones":[{"label":"mobile","value":"555-0142"}]}' "$JSON_PREFIX" "$JSON_PREFIX" | "$CX" create --json 2>&1)
echo "$output"
assert_contains "Created" "$output"

JSON_ID=$(echo "$output" | grep -o '([a-fA-F0-9]\{8\})' | tr -d '()')
echo "  Contact ID: $JSON_ID"
CREATED_IDS+=("$JSON_ID")

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

# Characterization: cmdUpdate skips addMultiValueFields in JSON mode, so an
# "emails" key on update is silently ignored. Commit E3 gives JSON update
# replace semantics for collections — invert this assertion then.
assert_not_contains "${JSON_PREFIX}-home@example.com" "$output"

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
CGROUP_NAME="${TEST_PREFIX}_CGroup"
"$CX" groups create "$CGROUP_NAME"
CREATED_GROUPS+=("$CGROUP_NAME")

FLAG_PREFIX="${TEST_PREFIX}F"
output=$("$CX" create --first "${FLAG_PREFIX}" --last "Person" --group "$CGROUP_NAME" 2>&1)
echo "$output"
FLAG_ID=$(echo "$output" | grep -o '([a-fA-F0-9]\{8\})' | tr -d '()')
CREATED_IDS+=("$FLAG_ID")

output=$("$CX" groups members "$CGROUP_NAME" 2>&1)
assert_contains "${FLAG_PREFIX}" "$output"

# --group survives JSON mode as of D1. It used to be dropped: cmdCreate
# replaced the parsed flags with the JSON payload before reading flags.group,
# so the flag the user typed was gone by the time it was read.
JGROUP_PREFIX="${TEST_PREFIX}JG"
output=$(printf '{"firstName":"%s","lastName":"Person"}' "$JGROUP_PREFIX" | "$CX" create --json --group "$CGROUP_NAME" 2>&1)
echo "$output"
JGROUP_ID=$(echo "$output" | grep -o '([a-fA-F0-9]\{8\})' | tr -d '()')
CREATED_IDS+=("$JGROUP_ID")

output=$("$CX" groups members "$CGROUP_NAME" 2>&1)
assert_contains "${JGROUP_PREFIX}" "$output"

# --- Test: dates ---
# Regression for the timezone defect: a birthday entered as 1990-05-14 was
# stored as 1990-05-13 in any negative UTC offset, because new Date() parses a
# date-only string as UTC midnight. --date took a raw string where --birthday
# took a Date; both now parse identically.
echo ""
echo "=== Dates ==="
DATE_PREFIX="${TEST_PREFIX}D"
output=$("$CX" create --first "${DATE_PREFIX}" --last "Person" --birthday 1990-05-14 --date "anniversary:2000-01-02" 2>&1)
echo "$output"
DATE_ID=$(echo "$output" | grep -o '([a-fA-F0-9]\{8\})' | tr -d '()')
CREATED_IDS+=("$DATE_ID")

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
output=$("$CX" create --first "${ORDER_PREFIX}" --last "Person" 2>&1)
ORDER_ID=$(echo "$output" | grep -o '([a-fA-F0-9]\{8\})' | tr -d '()')
CREATED_IDS+=("$ORDER_ID")

"$CX" delete --force "$ORDER_ID"
# Left in CREATED_IDS deliberately: cleanup tolerates an already-deleted ID,
# and removing an element from a bash array is not worth the noise.
output=$("$CX" search "${ORDER_PREFIX}" 2>&1)
assert_not_contains "${ORDER_PREFIX}" "$output"

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
