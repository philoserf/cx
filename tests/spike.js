// Gate B spike — does plural Apple Event access beat per-object access?
// Throwaway. Not part of cx. Run with:  osascript -l JavaScript spike.js
// Reads only; creates, modifies and deletes nothing.

ObjC.import("Foundation");

function out(msg) {
	const h = $.NSFileHandle.fileHandleWithStandardOutput;
	const s = $.NSString.alloc.initWithUTF8String(`${msg}\n`);
	h.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding));
}

function pad(str, len) {
	return str.length >= len ? str : str + " ".repeat(len - str.length);
}

// Runs fn, prints elapsed seconds and whatever note fn returns.
// Returns fn's value, or null if it threw — a throw here is a result, not a
// crash: it means the hypothesis is unsupported by this scripting interface.
function time(label, fn) {
	const t0 = Date.now();
	let value;
	try {
		value = fn();
	} catch (e) {
		out(`${pad(label, 34)}  ---     UNSUPPORTED: ${e.message}`);
		return null;
	}
	const secs = ((Date.now() - t0) / 1000).toFixed(2);
	out(`${pad(label, 34)}  ${pad(`${secs}s`, 8)}${value && value.note ? value.note : ""}`);
	return value;
}

const app = Application("Contacts");

// Force the connection before timing anything, so the first measurement does
// not absorb Apple Event startup and TCC cost.
app.name();

out("");
out("=== gate B spike ===");
out("");

// --- what cx does today ---

const people = time("app.people()", () => {
	const p = app.people();
	return { value: p, note: `${p.length} people` };
});

if (!people) {
	out("");
	out("Could not enumerate people. Is automation permission granted?");
} else {
	const all = people.value;
	const count = all.length;

	time("loop: id() over all", () => {
		let last = "";
		for (let i = 0; i < count; i++) last = all[i].id();
		return { note: `${count} round trips, last=${last.substring(0, 8)}` };
	});

	const SAMPLE = Math.min(25, count);
	time(`loop: summary over ${SAMPLE}`, () => {
		for (let i = 0; i < SAMPLE; i++) {
			all[i].id();
			all[i].name();
			all[i].organization();
			all[i].emails();
			all[i].phones();
		}
		return { note: `x${(count / SAMPLE).toFixed(1)} for the full book` };
	});

	out("");

	// --- the hypotheses ---

	const ids = time("plural: app.people.id()", () => {
		const v = app.people.id();
		return { value: v, note: `${v.length} ids, first=${String(v[0]).substring(0, 8)}` };
	});

	time("plural: app.people.name()", () => {
		const v = app.people.name();
		return { value: v, note: `${v.length} names, first=${v[0]}` };
	});

	time("plural: app.people.organization()", () => {
		const v = app.people.organization();
		return { value: v, note: `${v.length} orgs` };
	});

	time("nested: app.people.emails.value()", () => {
		const v = app.people.emails.value();
		const flat = Array.isArray(v[0]) ? "array of arrays" : `flat (${typeof v[0]})`;
		return { value: v, note: `${v.length} entries, ${flat}` };
	});

	time("nested: app.people.phones.value()", () => {
		const v = app.people.phones.value();
		const flat = Array.isArray(v[0]) ? "array of arrays" : `flat (${typeof v[0]})`;
		return { value: v, note: `${v.length} entries, ${flat}` };
	});

	if (ids) {
		const prefix = String(ids.value[0]).substring(0, 8);
		time("whose: id _beginsWith", () => {
			const v = app.people.whose({ id: { _beginsWith: prefix } })();
			return { note: `${v.length} match for ${prefix}` };
		});
		// resolveId matched with indexOf, which is case sensitive. If the
		// server-side query is not, lowercase short IDs start working.
		time("whose: id _beginsWith lowercase", () => {
			const lower = prefix.toLowerCase();
			const v = app.people.whose({ id: { _beginsWith: lower } })();
			return { note: `${v.length} match for ${lower}` };
		});
	}

	// cmdList reads app.people, but cmdSearch reads a whose() specifier and
	// groupsMembers reads a group's people. If plural access works on those
	// too, one bulk reader serves all three; if not, they keep the per-object
	// loop, which is already sub-second at their sizes.
	time("plural on whose() specifier", () => {
		const v = app.people.whose({ name: { _contains: "a" } }).name();
		return { note: `${v.length} names` };
	});

	time("plural on group.people", () => {
		const groups = app.groups();
		if (groups.length === 0) return { note: "no groups on this machine" };
		const v = groups[0].people.name();
		return { note: `${v.length} names in ${groups[0].name()}` };
	});

	out("");
	out("Ordering check — plural arrays must line up by index or E1 would");
	out("attribute one person's email to another:");
	if (ids) {
		const names = app.people.name();
		const sameLength = ids.value.length === names.length && ids.value.length === count;
		out(`  lengths agree: ${sameLength} (${count} / ${ids.value.length} / ${names.length})`);
		const idx = Math.min(3, count - 1);
		out(`  element ${idx} via loop:   ${all[idx].id().substring(0, 8)}  ${all[idx].name()}`);
		out(`  element ${idx} via plural: ${String(ids.value[idx]).substring(0, 8)}  ${names[idx]}`);
	}
	out("");
}
