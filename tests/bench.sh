#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CX="$SCRIPT_DIR/../cx"
TEST_PREFIX="CxBench_$$"
CREATED_IDS=()
CREATED_GROUPS=()

cleanup() {
	for id in "${CREATED_IDS[@]}"; do
		"$CX" delete "$id" --force 2>/dev/null || true
	done
	for group in "${CREATED_GROUPS[@]}"; do
		"$CX" groups delete "$group" --force 2>/dev/null || true
	done
}
trap cleanup EXIT

bench() {
	local label="$1"
	shift
	local start end elapsed
	start=$(gdate +%s.%N)
	"$@" >/dev/null 2>&1
	end=$(gdate +%s.%N)
	elapsed=$(echo "$end - $start" | bc)
	printf "  %-30s %ss\n" "$label" "$elapsed"
}

echo "=== cx benchmark (${TEST_PREFIX}) ==="
echo ""

# --- List ---
echo "List:"
bench "list (cold)" "$CX" list
bench "list (warm)" "$CX" list

# --- Search ---
echo ""
echo "Search:"
bench "search (hit)" "$CX" search Ayers
bench "search (miss)" "$CX" search zzzznonexistent

# --- Create ---
echo ""
echo "Create:"
bench "create (flags)" "$CX" create --first "${TEST_PREFIX}" --last Person --note "bench note" --email "work:bench@example.com"
CONTACT_ID=$("$CX" search "${TEST_PREFIX}" 2>&1 | awk 'NR==3{print $1}')
CREATED_IDS+=("$CONTACT_ID")

# --- Get ---
echo ""
echo "Get:"
bench "get (short id)" "$CX" get "$CONTACT_ID"

# --- Update ---
echo ""
echo "Update:"
bench "update (note)" "$CX" update "$CONTACT_ID" --note "updated bench note"

# --- Groups ---
echo ""
echo "Groups:"
GROUP_NAME="${TEST_PREFIX}_Group"
CREATED_GROUPS+=("$GROUP_NAME")
bench "groups create" "$CX" groups create "$GROUP_NAME"
bench "groups list" "$CX" groups list
bench "groups add" "$CX" groups add "$CONTACT_ID" "$GROUP_NAME"
bench "groups members" "$CX" groups members "$GROUP_NAME"
bench "groups remove" "$CX" groups remove "$CONTACT_ID" "$GROUP_NAME"
bench "groups delete" "$CX" groups delete "$GROUP_NAME" --force
CREATED_GROUPS=()

# --- Delete ---
echo ""
echo "Delete:"
bench "delete (force)" "$CX" delete "$CONTACT_ID" --force
CREATED_IDS=()

echo ""
echo "Done."
