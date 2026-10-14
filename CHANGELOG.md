# Changelog

All notable changes to pi-governor are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Package scaffold: TypeScript sources under `extensions/`, `node --test` tests, and a peer dependency on `@earendil-works/pi-coding-agent` `>=1.1.0 <1.2.0`.
- `computeMcpToolNames(server, tool)`: the plain and hash-suffixed names pi 1.1 can register for an MCP tool, for matching rules against live tool names.
- Rules and verdicts (`decide`, `validateRule`, `ruleNamesTool`): a rule names a tool by registered name, `*` pattern or original server and tool names, can narrow by argument values, and gives `allow`, `ask` or `never`; the strictest matching rule wins.
- Source defaults for tools no rule names: `mcp` (shipped `hints`: pass only a declared `readOnlyHint`), `builtin` and `extension` (shipped `allow`), and `unknown` (always `ask`). Set in `~/.pi/agent/governor.json`; `.pi/governor.json` can only tighten, and an invalid file makes every source ask.
- `registerRules(pi, { id, rules, whenNoHost })` in `pi-governor/client`: a package registers its rules through a `Symbol.for("pi-governor/registry")` registry on `globalThis`, in any load order. `whenNoHost` is required, with no default: `"block"` blocks the calls the package's ask and never rules cover until a host takes the rules, or a handler function decides them; leaving it out throws at registration. Rules are validated and frozen when registered, one package cannot replace another's rules even with the same id, and a session without a host handler of its own (a subagent child that loads no host) still gets the `whenNoHost` behaviour.
- The guard host (`extensions/governor/host.ts`): a `tool_call` handler that applies the rules and source defaults to every call, nested calls included, and fails closed. `never` blocks and tells the model not to retry. `ask` opens one dialog at a time with a timeout, and a timeout, a decline, a dialog error or an abort all block with a reason that says which. With no UI the call is blocked and the reason tells the model to ask the user. An optional approval window, per tool and rule, skips the dialog for a set time; a nested call from a rule's `trustedParents` skips it too.
- The approval dialog shows the arguments as they are sent: control, escape, bidi and invisible characters appear as `<U+XXXX>` markers, a clipped value states its full length, a multi-line value cannot pass for another argument, and a rule's own `preview` is shown together with a list of every argument it leaves out (or replaced by the full argument list if the preview fails).
- Package entry points: `pi-governor` (the pure pieces: `decide`, `validateRule`, `snapshotRule`, `ruleApplies`, `ruleNamesTool`, `parseConfig`, `resolveDefaults` and the name helpers) and `pi-governor/client` (`registerRules`). The package loads `extensions/governor/host.ts` as its pi extension.
- A `whenNoHost` handler may return only nothing, `null`, `{ block: false }` or `{ block: true, reason? }`. Anything else (`false`, `{}`, `{ blocked: true }`) blocks the call, because pi runs a call unless the result is an object with a truthy `block`.
- A dialog that gets no answer within its timeout plus a short grace period (a UI that ignores the timeout) blocks the call and no longer stalls later asks; calls queued behind a dialog do not open their own after the operation is aborted.
- Characters that hide content (zero-width joiners, variation selectors, tag characters, Hangul and Braille fillers, and similar) show as `<U+XXXX>` markers in dialogs and block reasons.
- A rule's preview is checked against the arguments more strictly: a short value (`true`, `a`, `5`) counts as shown only if the preview also names its argument, so an argument is never taken for shown just because its letters occur in the text.
- A call id that two different tools used names neither as a `trustedParents` parent, and a registration a live store refused stays queued for a later host.
- If `governor.json` cannot be located or read when a session starts, every source asks instead of keeping the shipped defaults.
