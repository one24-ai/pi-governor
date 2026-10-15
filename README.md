# pi-governor

A guard layer for [pi](https://pi.dev) tool calls. It decides, in one place, which tool calls the model may make, which need your approval first, and which are never allowed. Other packages register rules with it. It was called pi-containment until the rename; the `pi-containment` placeholder on npm is deprecated.

Status: phase 1 (rules for every tool call) is built. Phase 2, an optional OS sandbox for bash, is design only.

It is not a full sandbox. It gates tool calls (including MCP and extension tools). pi's own process, other extensions' code and MCP servers still run with your permissions. For full isolation, run pi in a container (see pi's `docs/containerization.md`).

## What it does

pi does not ask before a tool call. Anything the model reads (a chat message, a ticket body, command output) can steer it into calling a write tool. pi-governor puts one check in front of every call:

- A rule gives a tool a verdict: `allow`, `ask` or `never`. The strictest matching rule wins.
- `ask` opens one dialog showing the arguments as they would be sent. Control, escape and invisible characters show as `<U+XXXX>` markers, a clipped value states its full length, and a rule's own preview is followed by a list of any argument it leaves out. A decline, a timeout, a dialog error and an abort all block the call. With no UI the call is blocked and the model is told to ask you.
- A tool no rule names follows the default for its source. Shipped: MCP tools pass only if the server declares `readOnlyHint`; built-in and extension tools pass. A tool missing from pi's tool list always asks.
- Calls that a codemode script or another tool makes are checked like top-level ones.

## Install

```bash
pi install npm:pi-governor
```

It adds one command, `/governor`, which lists the live rule packs, the source defaults, any rule that matches no live tool, the live approvals, and what is not covered. `/governor revoke` drops every live approval (the next call a window covered asks again) and says how many it dropped; any other argument prints a usage line. It needs pi 1.2.x (`@earendil-works/pi-coding-agent` `>=1.2.0 <1.3.0`).

## Settings

`~/.pi/agent/governor.json` sets the default for each source of tool:

```json
{ "defaults": { "mcp": "hints", "builtin": "allow", "extension": "allow" } }
```

Values are `allow`, `hints` (pass only a declared `readOnlyHint`), `ask` and `never`. `.pi/governor.json` in a project can only tighten these.

`"freezeArguments"` (true or false, default true) freezes the arguments of every call before the guard checks it, so a later extension cannot change what was approved (see below). Only the global file can turn it off; a project file can only turn it on. A file that is missing keys is fine; a file that cannot be read, or has an unknown key or value, makes every source ask until it is fixed.

## Register rules from your package

```ts
import { registerRules } from "pi-governor/client";

export default function (pi) {
	registerRules(pi, {
		id: "my-pack",
		rules: [
			{ tool: { server: "tracker", tool: "get_issue" }, verdict: "allow" },
			{
				tool: { server: "tracker", tool: "create_comment" },
				verdict: "ask",
				preview: (args) => `Comment on ${args.issue}`,
			},
			{ tool: { server: "tracker", tool: "delete_issue" }, verdict: "never" },
		],
		whenNoHost: "block",
	});
}
```

`whenNoHost` is required and has no default. It says what happens to the calls your ask and never rules cover when pi-governor is not loaded: `"block"` blocks them, or give a function that decides them itself. Leaving it out throws at registration. Load order does not matter, and your package does not need pi-governor installed to load.

A rule names a tool by its registered name (exact and case-sensitive, `*` is the only wildcard) or by the server and tool names as the server reports them; pi-governor works out the name pi registers, including the hash suffix pi adds when a name is long or collides.

### Rule fields

- `tool`: a registered name, a `*` pattern, or `{ server, tool }`. Works the same with `when`, `reason` and `title`.
- `verdict`: `allow`, `ask` or `never`.
- `args`: only when every listed top-level argument equals the given value (`string`, `number`, `boolean` or `null`).
- `when(args)`: a synchronous check on the arguments, for what equality cannot say (a command text that matches a pattern, an `operation` that starts with `get_`). It must return exactly `true` or `false`, and both `args` and `when` must hold for the rule to apply. It receives the call's arguments after the guard has frozen them, and is not called when the arguments are not a plain object. Fail closed: if `when` throws, returns a Promise or returns anything but a boolean, an `ask` or `never` rule counts as matching (stricter) and an `allow` rule counts as not matching. Arguments that are not a plain object also match an `ask` or `never` rule and not an `allow` rule. `/governor` shows that a rule has a predicate and nothing about what it checks.
- `reason` (`never` only, 1 to 500 characters): added to the block message after "Do not retry it", so you can tell the model what to do instead. If several `never` rules match, the first one that has a reason supplies it. It is sanitised like any text from a rule.
- `title` (`ask` only, 1 to 100 characters): the dialog title instead of "Allow <tool>?". With several matching `ask` rules, the first one that has a title supplies it.
- `preview(args)` (`ask` only): the text the dialog shows for the arguments.
- `windowMs` (`ask` only): approvals last this long. An approval covers the tool and the set of rules that asked, not the argument values: a rule with `when` and `windowMs` is one approval for every call it matches during the window, not one per value. Put anything the user must approve each time in a rule without a window.
- `trustedParents` (`ask` only): tools that have asked already, whose nested calls skip the dialog.

```ts
{ tool: "bash", verdict: "never", when: (args) => /\bforce-deploy\b/.test(String(args.command)), reason: "Deploys go through the ops tool." },
{ tool: { server: "ops", tool: "run" }, verdict: "ask", title: "Run an ops task?", when: (args) => !String(args.operation).startsWith("get_") },
```

## What it does not do

- It cannot limit what an allowed bash command does once it runs (phase 2).
- Subagent children are covered only if the host that launches them loads this extension into them. `/governor` says so rather than guessing. A child has no UI, so every ask call is blocked there.
- Another extension can change a call's arguments in place after this one has checked them if it is loaded after this one (measured on pi 1.1.0 and 1.2.0). So this extension freezes the arguments of every call before it checks them: such an edit cannot change what the tool receives. In strict-mode code (every ES module, so any TypeScript extension) the write throws ("Cannot assign to read only property") and pi fails the call without running it; in sloppy-mode code the write is silently ignored and the call runs with the checked arguments. A value that cannot be frozen (a Map, Set, Date, binary data, a Proxy or an accessor) makes the guard block the call; calls the model makes contain none of these, only calls another extension makes itself can. A handler loaded before this one is safe either way, because this extension checks what will actually be sent. The cost is that an extension that edits arguments on purpose will break, and so will a tool that rewrites its own parameters inside its `execute()` (nothing in pi's built-in tools does, but a third-party tool might); none of the extensions checked in the author's setup do. Turn it off with `"freezeArguments": false` in the global file, and `/governor` then says the gap is open.
- Written and measured against pi 1.2.x (the first measurements were on 1.1.0 and were repeated on 1.2.0). TUI mode was exercised by hand for the status command and the dialog; background subagent children and a child with MCP tools have not been exercised.

See [docs/design.md](docs/design.md) for the design and the measurements behind it.

## License

MIT
