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
