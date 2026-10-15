# Changelog

All notable changes to pi-governor are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Subagent children are governed.** With pi-subagents (0.78 or later), the host registers itself at `session_start` as an extension every native Pi child of the session must load, through pi-subagents' `registerRequiredChildExtensions`. Before, a foreground child loaded no governor unless its agent listed it, and its calls ran unchecked, `never` rules included (measured). It registers under `sessionManager.getSessionId()`, the key pi-subagents looks up, and finds the hook in the pi-subagents package this process loaded (from its tools' source and the package's `exports` map) before trying the package name and the agent dir. A foreground child shares the parent's rule packs; a background child has the source defaults, and a pack's rules only if that pack loads in it. External CLI runners are not covered. **Behaviour change:** while pi-governor is registered, pi-subagents refuses pane-native remote launches (another machine), because it cannot transfer local extensions there.
- `/governor` reports child coverage from what the session did: registered, pi-subagents not found (not known), registration failed (NOT covered, with the error), or not yet known. It used to say "not known" in every case.

## [0.2.0] - 2026-10-15

The new rule fields are additions, and a rule without them is evaluated as before. Two changes are **breaking for a package that registers rules**, and the package had no users when they were made: a rule with a field it does not have is now rejected, and a custom dialog title now carries the tool name.

### Changed

- **Breaking: a rule with a field it does not have is rejected at registration**, with the field named (`rule has no field "arg"; the fields are tool, args, when, ...`). The fields are `tool`, `args`, `when`, `verdict`, `reason`, `title`, `preview`, `windowMs` and `trustedParents`. A typo used to register without complaint and leave the narrowing out, so `{ verdict: "allow", arg: { path: "/safe" } }` (meant `args`) allowed every call to the tool. Symbol keys and inherited unknown names are rejected too.
- **Breaking: a rule's `title` no longer replaces the tool name.** The dialog title is now `<title> (<tool>)` and the message opens with `Tool: <tool>`, so a title cannot hide which tool is being asked about. Without a custom title the dialog is unchanged (`Allow <tool>?`).

### Added

- **`when(args)` on a rule**: a synchronous check on the call's arguments, for what `args` equality cannot say. Both `args` and `when` must hold. It runs on the arguments after the guard froze them and is not called when they are not a plain object. Fail closed: a throw, a Promise or any non-boolean result counts as a match for `ask` and `never` rules and as no match for `allow` rules; input that is not a plain object matches `ask` and `never` and not `allow`. The client fallback (`whenNoHost`) uses the same check. `/governor` shows that a rule has a predicate and nothing about what it checks. A rule with `windowMs` and `when` is one approval for every call it matches during the window, not one per argument value.
- **`reason` on a `never` rule** (1 to 500 characters): added to the block message after the instruction not to retry. **`title` on an `ask` rule** (1 to 100 characters): the start of the dialog title, followed by the tool name. Both are sanitised and clipped, and rejected at registration on the other verdict or when empty or too long.
- **`/governor revoke`** drops every live approval and says how many. Any other argument prints a usage line instead of the status; plain `/governor` still prints the status.

## [0.1.1] - 2026-10-15

### Fixed

- A test of the release script cut the repository's own changelog, so it failed on every commit after a release (CI and the release workflow went red on `v0.1.0`). It now uses a fixed sample. The published package is unchanged.

## [0.1.0] - 2026-10-15

First release. Phase 1 of [docs/design.md](docs/design.md): rules for every tool call. Phase 2, an optional OS sandbox for bash, is design only.

### Added

- **Rules and verdicts.** A rule gives a tool `allow`, `ask` or `never`. It names the tool by its registered name, a `*` pattern, or the server and tool names as the server reports them (pi-governor works out the hash suffix pi adds to long or colliding MCP names). It can narrow by argument values, and the strictest matching rule wins. Matching is exact and case-sensitive.
- **Source defaults** for tools no rule names, set in `~/.pi/agent/governor.json`: `mcp` passes only a declared `readOnlyHint` (`hints`), `builtin` and `extension` pass (`allow`), and a tool missing from pi's tool list always asks. `.pi/governor.json` in a project can only tighten, and a file that cannot be read or has an unknown key or value makes every source ask.
- **`registerRules(pi, { id, rules, whenNoHost })`** in `pi-governor/client`, in any load order. `whenNoHost` is required, with no default: `"block"` blocks the calls the package's ask and never rules cover until a host takes the rules, or a handler function decides them. Leaving it out throws at registration, and a handler may return only nothing, `null`, `{ block: false }` or `{ block: true, reason? }`; anything else blocks. Rules are validated and frozen when registered, one package cannot replace another's even with the same id, and a session that has no host handler of its own gets the `whenNoHost` behaviour.
- **The guard host** (`extensions/governor/host.ts`, loaded as the package's pi extension): a `tool_call` handler that fails closed and checks nested calls (such as a codemode script's) like top-level ones. `never` blocks and tells the model not to retry. A rule can name `trustedParents` whose nested calls skip the dialog, and an optional approval window per rule.
- **The approval dialog**, one at a time and always with a timeout. A decline, a timeout (including a UI that ignores the timeout), a dialog error and an abort all block, with a reason that says which. With no UI the call is blocked and the model is told to ask the user. Control, escape, bidi and invisible characters (zero-width joiners, variation selectors, tag characters, fillers) show as `<U+XXXX>` markers, a clipped value states its full length, a multi-line value cannot pass for another argument, and a rule's own `preview` is followed by a list of every argument it does not demonstrably show.
- **Argument freezing.** A `tool_call` handler loaded after the guard could change a call's arguments in place and the tool would receive the change (measured on pi 1.1.0 and 1.2.0). The guard freezes the arguments before it decides anything, so such a write throws in strict-mode code (and pi fails the call) or is ignored in sloppy-mode code, and a handler that kept a reference cannot change them while a dialog is open. A value that cannot be frozen (a Map, Set, Date, binary data, a Proxy, an accessor or a function) blocks the call. **This can break an extension that edits arguments on purpose, and a tool that rewrites its own parameters inside `execute()`.** `"freezeArguments": false` in the global `governor.json` turns it off; a project file can only turn it on, and a broken file keeps it on.
- **`/governor`** lists the live rule packs and rules, the source defaults and the state of both config files, rules that match no live tool, live approvals with their time left, the freeze setting, and whether this session has a governor handler. It says plainly that subagent children are not known to be covered.
- **Entry points:** `pi-governor` (the pure pieces: `decide`, `validateRule`, `snapshotRule`, `ruleApplies`, `ruleNamesTool`, `parseConfig`, `resolveDefaults` and the name helpers) and `pi-governor/client` (`registerRules`).
- Peer dependency on `@earendil-works/pi-coding-agent` `>=1.2.0 <1.3.0`. The behaviour was measured on pi 1.1.0 and again on 1.2.0.
- Release tooling: `pnpm release`, CI and a tag-driven publish workflow (see [RELEASING.md](RELEASING.md)).

[Unreleased]: https://github.com/one24-ai/pi-governor/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/one24-ai/pi-governor/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/one24-ai/pi-governor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/one24-ai/pi-governor/releases/tag/v0.1.0

