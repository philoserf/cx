# Changelog

## 2.1.1

No change to `cx` itself. This release is the repository's tooling and test
harness.

### Added

- `task setup` installs the toolchain from a new `Brewfile` (go-task,
  shellcheck, shfmt, bun, coreutils), and `task check` runs lint, then test.
  That is the gate.
- Markdown is formatted and checked by Prettier from the repository, rather than
  by a hook on one machine. `task lint` fails on drift. Biome and Prettier are
  pinned in `Taskfile.yml`, so a tool release cannot change the lint result.

### Fixed

- Test contacts left behind by a run whose cleanup failed are now deleted. Each
  run cleans up only its own pid's prefix, so nothing ever matched them again.
  `tests/test.sh` now starts by sweeping the prefixes of runs whose process has
  exited. A run still in progress keeps its contacts.
- The harnesses' "contacts remain" warning fires when the remaining count cannot
  be read. Before, an unknown count was reported as clean.

### Removed

- The CI workflow and Dependabot. The local `task check` is the gate.

## 2.1.0

### Added

- `cx search` matches the note, every email address and every phone number, in
  addition to names and organization. The note is the field this tool exists to
  reach, and it was the one thing that could not be found. Every value in a
  collection is searched, not just the first.

### Changed

- Search costs the same whether it finds nothing or most of the address book. A
  query matching 286 of 340 contacts took 55 seconds and now takes 1.2 seconds.
  A narrow query costs about 0.3 seconds more than it did, which is the trade.
- `cx help` and the README name what search matches, rather than saying only
  "Search contacts". A miss is no longer indistinguishable from a field that was
  never searched.

### Fixed

- `--url ssh://host` stored `//host` under a label named `ssh`. Any URI scheme
  outside `http`, `https`, `tel` and `mailto` was split at the first colon and
  silently mangled. A scheme followed by `//` is now recognised by its shape.
