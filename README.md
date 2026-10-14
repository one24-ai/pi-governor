# pi-governor

A guard layer for [pi](https://pi.dev) tool calls. It decides, in one place, which tool calls the model may make, which need your approval first, and which are never allowed. Other packages register rules with it. It was called pi-containment until the rename; the `pi-containment` placeholder on npm is deprecated.

Status: phase 1 (rules for every tool call) is built and not yet released. Phase 2, an optional OS sandbox for bash, is design only.

It is not a full sandbox. It gates tool calls (including MCP and extension tools). pi's own process, other extensions' code and MCP servers still run with your permissions. For full isolation, run pi in a container (see pi's `docs/containerization.md`).

## What it does

pi does not ask before a tool call. Anything the model reads (a chat message, a ticket body, command output) can steer it into calling a write tool. pi-governor puts one check in front of every call:

- A rule gives a tool a verdict: `allow`, `ask` or `never`. The strictest matching rule wins.
- `ask` opens one dialog showing the arguments as they would be sent. Control, escape and invisible characters show as `<U+XXXX>` markers, a clipped value states its full length, and a rule's own preview is followed by a list of any argument it leaves out. A decline, a timeout, a dialog error and an abort all block the call. With no UI the call is blocked and the model is told to ask you.
- A tool no rule names follows the default for its source. Shipped: MCP tools pass only if the server declares `readOnlyHint`; built-in and extension tools pass. A tool missing from pi's tool list always asks.
- Calls that a codemode script or another tool makes are checked like top-level ones.

## Install

Not published yet, so for now install from a checkout:

```bash
pi install /path/to/pi-governor
```

After the first release it will be `pi install npm:pi-governor`. It adds one command, `/governor`, which lists the live rule packs, the source defaults, any rule that matches no live tool, the live approvals, and what is not covered.

## Settings

`~/.pi/agent/governor.json` sets the default for each source of tool:

```json
{ "defaults": { "mcp": "hints", "builtin": "allow", "extension": "allow" } }
```

Values are `allow`, `hints` (pass only a declared `readOnlyHint`), `ask` and `never`. `.pi/governor.json` in a project can only tighten these. A file that is missing keys is fine; a file that cannot be read, or has an unknown key or value, makes every source ask until it is fixed.

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

## What it does not do

- It cannot limit what an allowed bash command does once it runs (phase 2).
- Subagent children are covered only if the host that launches them loads this extension into them. `/governor` says so rather than guessing. A child has no UI, so every ask call is blocked there.
- Another extension's `tool_call` handler that is loaded after this one can change a call's arguments in place after they were checked or approved, and the tool receives the changed arguments (measured on pi 1.1.0, for top-level and codemode calls). One loaded before it is safe: this extension then checks what will actually be sent. Load order is not something this package controls.
- Tested against pi 1.1.x only. TUI mode and background subagent children have not been exercised.

See [docs/design.md](docs/design.md) for the design and the measurements behind it.

## License

MIT
