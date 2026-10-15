# Changelog

All notable changes to pi-governor are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/one24-ai/pi-governor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/one24-ai/pi-governor/releases/tag/v0.1.0

