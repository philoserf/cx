#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CX="$SCRIPT_DIR/../cx"
# The trailing underscore matters: the sweep matches with _contains, so a
# bare pid prefix would also match a longer pid's run -- CxTest_1045 would
# sweep a concurrent CxTest_10450 suite's contacts out from under it.
TEST_PREFIX="CxBench_${$}_"

# Sweep by prefix rather than replaying a registered list -- see the longer
# note in tests/test.sh. bench() discards its command's output in order to time
# it, so there is no id to register at the moment of creation anyway.
cleanup() {
	local status=$?
	{
		"$CX" search "$TEST_PREFIX" --format json |
			/usr/bin/jq -r '.[].id' |
			while read -r id; do
				"$CX" delete "$id" --force 2>/dev/null || true
			done
	} || true
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

# --- Create ---
echo ""
echo "Create:"
bench "create (flags)" "$CX" create --first "${TEST_PREFIX}" --last Person --note "bench note" --email "work:bench@example.com"
# bench() sends stdout to /dev/null so the timing is clean, so the id has to be
# recovered. Read it from --format json rather than grepping column one of the
# rendered table, whose widths follow the data.
CONTACT_ID=$("$CX" search "${TEST_PREFIX}" --format json | /usr/bin/jq -r '.[0].shortId // empty')
if [[ -z "$CONTACT_ID" ]]; then
	echo "could not recover the benchmark contact's id" >&2
	exit 1
fi

# --- Search ---
# Runs after Create so that "hit" queries a contact this script owns. It used
# to search the author's surname, which measured a miss on anyone else's Mac.
#
# All three rows should now print the same figure, and that equality is the
# measurement. Search fetches every searchable property plurally and matches in
# JavaScript, so the cost is the fetch: constant in the number of matches,
# linear in the size of the address book. The hit/miss split used to mean the
# opposite -- a miss was cheap because nothing was read back, and a broad query
# was catastrophic because every hit was one Apple Event per property. The
# broad row is here because it was the worst case: 267 of 340 contacts, 55s.
echo ""
echo "Search:"
bench "search (hit)" "$CX" search "${TEST_PREFIX}"
bench "search (miss)" "$CX" search zzzznonexistent
bench "search (broad)" "$CX" search e

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
GROUP_NAME="${TEST_PREFIX}Group"
bench "groups create" "$CX" groups create "$GROUP_NAME"
bench "groups list" "$CX" groups list
bench "groups add" "$CX" groups add "$CONTACT_ID" "$GROUP_NAME"
bench "groups members" "$CX" groups members "$GROUP_NAME"
bench "groups remove" "$CX" groups remove "$CONTACT_ID" "$GROUP_NAME"
bench "groups delete" "$CX" groups delete "$GROUP_NAME" --force

# --- Delete ---
echo ""
echo "Delete:"
bench "delete (force)" "$CX" delete "$CONTACT_ID" --force

echo ""
echo "Done."
