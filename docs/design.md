# pi-governor design

Status: design, not yet implemented. pi-governor is a guard layer for pi tool calls, built in two phases: rules for every tool call first, then an optional OS sandbox for bash (see "Phase 2: a bash sandbox"). It started as a proposal in [pi-chassis](https://github.com/one24-ai/pi-chassis), whose Plan mode is its first planned registrant. File paths under `extensions/chassis/` below refer to the pi-chassis repo.

## Problem

pi does not ask before a tool call (its own `docs/security.md` says so) and has no permission settings. Its only controls are `--tools` and `--exclude-tools`, which switch a tool on or off for the whole session.

pi-chassis's Plan mode does not fill the gap. The pi-chassis README's Build / Plan bullet says it is a guardrail, not a sandbox, and that tools from other extensions (MCP and custom tools) are not restricted. In `extensions/chassis/modes.ts`, the `tool_call` handler blocks `edit`, `write` and unsafe `bash` by name and returns for everything else.

So the write tools of an MCP server are callable by the model with no prompt. Take an issue-tracker MCP server whose tools add a comment, transition an issue, create an issue, edit fields, log work or link issues, or a chat MCP server that can send messages. Anything the model reads (a chat message, a ticket body, a log line, command output) can steer it into calling one of those. Prompt injection is the realistic path, not a corner case.

An extension that wants to offer writes only behind a preview the user approves has no shared place to put that rule. Each package has to write its own `tool_call` handler, its own dialog and its own no-UI behaviour, and none of them can see the others' rules.

## Proposal

A guard layer that other packages register rules with. One place decides which tool calls the model may make, which need the user's yes, and which are never allowed.

### Rules

A rule is plain data:

- A tool match: the name pi registers, or a `*` pattern. For MCP tools the name is `mcp__<server>__<tool>`, where pi rewrites every character other than letters, digits and underscore to `_`, and adds an 8-character hash suffix when the name is longer than 64 characters or when two tools sanitize to the same name (see "Match on the name pi registers").
- An optional narrowing by arguments (for example, only when a given field has a given value).
- A verdict: `allow`, `ask` or `never`.
- For `ask`, a `preview(args)` that returns the text the dialog shows, so the user sees the exact values that would be sent.
- For `ask`, an optional approval window. Without one, every call asks.

### Default for tools no rule names

Use the annotations that `pi.getAllTools()` reports (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). A tool without `readOnlyHint` true asks. A rule pack can mark the read tools of a server that declares no hints as `allow`.

Annotations are declared by the server and pi does not verify them. They are a default, not a boundary. A `never` or `ask` rule always wins over a hint.

### One dialog, one fail-closed path

Every `ask` rule goes through the same dialog and the same failure behaviour. With no UI (print mode, RPC without a client, a subagent child) an `ask` call is blocked, and the reason tells the model to ask the user instead.

A declined dialog also blocks, and the reason tells the model not to retry the call.

### Approval windows

Approvals last a window only when a rule asks for one. The default for a write is to ask every time, because each payload differs and the preview is the point. A window suits cases where the payload is not what the user is approving, for example a series of reads against a tool that is not marked read-only.

### Nested calls

An `ask` rule applies to calls that a codemode script or another tool makes. A rule can name parent tools that are trusted to have asked already, for example a tool that has its own confirm dialog. A nested call from such a parent skips the guard's dialog; every other nested call is gated like a top-level one.

### Registration and the missing-host case

Packages register with the guard the way pi-chassis's widget client registers with pi-chassis (`extensions/chassis/client.ts` in pi-chassis): through a `Symbol.for` registry on `globalThis`. The widget client looks for the `pi-halo/registry` key, checks `apiVersion`, queues the registration under `pi-halo/pending` when the host has not loaded yet, and when the host never appears falls back at `session_start`. `extensions/chassis/api.ts` is the host side: it sets `apiVersion` on the registry and takes over the queued registrations when it loads. A guard client would use the same shape, so load order does not matter.

The fallback is where the two differ. The widget client's fallback with no pi-chassis is a status line (`ctx.ui.setStatus`), which is harmless. The same kind of fallback for a guard would let writes through with nobody asking.

So the registering package must choose in the registration call, with no default:

- `whenNoHost: "block"`: the tools its rules cover are blocked until a guard host is present.
- `whenNoHost: <handler>`: the package installs a minimal `tool_call` handler of its own for those tools.

A rule pack that skips the choice fails loudly at registration (it throws), rather than discovering the gap at `session_start`. The option name above is illustrative.

### Status command

A command (for example `/governor`) lists the live rules, the live approvals and whether subagent children are covered, and says plainly which.

## Findings

Most of these were measured in a live pi session; the one marked as read from types was not. They were measured with pi 1.1. Re-verify all of them against the pi version this package's `peerDependencies` names before building.

- `tool_call` handlers fire for every MCP call, including calls that a codemode script or another tool makes. Those events carry `parentToolCallId`, and nested ids look like `<parent id>/<n>`. The parent's `tool_execution_start` event carries its tool name, so a guard can learn which tool made a nested call.
- In print mode `ctx.hasUI` was false and `ctx.mode` was `"print"`.
- Annotations differ by server. `pi.getAllTools()` reported, for one issue-tracker server, all 20 tools annotated (14 with `readOnlyHint` true, the 6 writes false). For one chat server it reported 18 annotated (12 read-only). For one deployment-control server it reported 22 tools with none annotated. codemode's `ALL_TOOLS` does not carry annotations; only `pi.getAllTools()` does.
- Read from pi's type declarations, not measured: a `tool_call` handler receives an `ExtensionContext`, and only the context a running tool's `execute()` receives (`ExtensionToolContext`) has `executeTool()`. So a handler cannot call tools, and a preview cannot look anything up. A transition that takes an id can show the status name only if the session already read the transitions.
- `pi.getAllTools()` gives each MCP tool a `namespace` (for example `mcp__tracker` for `mcp__tracker__create_issue`), an `annotations` object and an `exposure`. Read from pi's source, not measured: the namespace is `mcp__<server>` with only `-` replaced by `_`, while tool names replace every character other than letters, digits and underscore, so the two can disagree for server names with other characters. No tool in the measured session had a hash suffix.
- Read from pi's source (`createMcpToolName` in its MCP extension), not measured: the registered name is `mcp__<server>__<tool>` sanitized as above. When that is longer than 64 characters, or already taken by a different MCP tool, pi cuts it and appends `_` plus the first 8 hex characters of SHA-256 over `<server>\0<tool>` (the original names). The suffix is deterministic.
- pi core ships `examples/extensions/permission-gate.ts`, the same pattern for a few bash commands, with nothing configurable.
- A downstream brand package already has a `tool_call` guard with an ask dialog, fail-closed behaviour without a UI, a 15-minute approval window and a status command. Its rules are hardcoded and another package cannot add one. That is the shape this proposal would make shareable.

Not measured: behaviour in subagent children (see below), and behaviour of any pi version other than the one in the session.

## Care needed

A missing guard must not mean ungated. This is the reason for the registration choice. A rule pack that is installed without its host must either block what it covers or carry its own handler, and it must say which when it registers. There is no default that is safe in both directions.

Subagent children. Whether a child is covered depends on how the host loads extensions into children, which is not something a rule can see. The layer either carries that coupling (and so knows how the host does it) or the host supplies it. Either way the status command must say plainly which, and whether children are covered right now. A guard that looks covered in children but is not is worse than none, because the user stops watching. A child with no UI blocks every `ask` call, which is safe but will stall a child that needs a write, and the reason should say so.

Dialog text is built from untrusted arguments. Strip control characters (including escape sequences) before showing them. When a value is clipped, show its full length. A preview must never hide what is actually sent: if the preview cannot show all of an argument, the dialog says so, or the call is blocked.

Match on the name pi registers. Do not match on the server's own tool name or on a display label. Matching is exact and case-sensitive on the registered name, and `*` patterns are the only wildcard. A rule should be able to name a server and a tool by their original names, and the layer computes the registered name the same way pi does: sanitize, then add the hash suffix when the name is too long or taken. Since the suffix is deterministic, the rule author never guesses it. Two cases still need care. Whether a name was taken depends on the other tools loaded, so the layer checks its computed names against `pi.getAllTools()` at `session_start` and reports a rule that matches no live tool. And a `*` pattern written against the unsuffixed form can miss a suffixed name, so patterns should be matched against both the registered name and the computed unsuffixed form. Do not resolve names through `namespace`, which sanitizes differently. The algorithm is pi's, not a public API, so the layer pins it with tests against the pi version it supports.

Plan mode's bash allowlist is a different problem. It parses shell (`extensions/chassis/readonly-command.ts`) and decides whether a command line can write. That stays in pi-chassis and out of the rules layer. Phase 2 replaces the need for it where an OS sandbox is available, and it remains the fallback where one is not.

## Phase 2: a bash sandbox

The rules layer decides whether a call happens. It cannot limit what an allowed bash command does once it runs. Phase 2 adds that, for bash only, as an optional part of the same package.

What an extension can confine, read from pi's source and examples (not measured):

- bash. `createBashTool` accepts `operations` (a `BashOperations` that runs the command) and a `spawnHook` that can rewrite the command, cwd and env before it runs, and the `user_bash` event lets an extension supply the operations for the user's own `!` commands. pi ships `examples/extensions/sandbox/`, which wraps every bash command with `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux, sandbox-exec on macOS) using filesystem and network rules from a JSON config. That example replaces the built-in bash tool; its comments note that rewriting the command in a `tool_call` handler is an alternative that leaves the tool in place.
- read, write and edit. These run in pi's own process, so no OS sandbox applies. The rules layer can still limit them by path (for example never write outside the working folder, never read a credentials folder). That is a rule, not a boundary.

What no extension can confine: pi's own process, other extensions' code, and MCP servers, which are separate processes with their own access. pi's `docs/security.md` places the lack of a built-in sandbox outside its security boundary, and `docs/containerization.md` describes running all of pi in a container or managed sandbox for real isolation. pi-governor's README says this in its first lines: it confines bash and gates tool calls, and full isolation means running pi in a container.

Shape:

- A sandbox profile is filesystem and network rules for bash, set in config (global and per project) and selectable by registrants. Plan mode asks for a read-only profile: the working folder readable, nothing writable except a scratch folder.
- Where the platform has no supported sandbox (Windows, or Linux without bubblewrap), the package falls back to the rules layer alone, and the status command says so. It never reports bash as confined when it is not.
- If bash is wrapped by rewriting the command in a `tool_call` handler, it must run after the rules decide and must not be undone by another handler. If the built-in tool is replaced instead, the tool's renderer and other packages' renderers for `bash` must keep working; check this against pi-chassis's tool rows.

Costs: a system dependency (bubblewrap) and a third-party npm dependency to pin and review, platform work and tests for each operating system, and network filtering through a proxy, which is weaker than the filesystem rules. These are why the rules layer ships first.

Tests for phase 2: a write outside the allowed paths fails inside the sandbox; a read-only profile blocks writes to the working folder; with no sandbox available the status command reports bash as not confined and Plan mode falls back to the command allowlist; the user's `!` commands are confined when the config says so.

## Relation to pi-chassis's Plan mode

The Plan-mode item in pi-chassis's `TODO.md` already says the sandbox should "gate every write-capable tool including MCP and extension tools (an allow-list of read-only tools rather than blocking edit/write by name)". That MCP and extension-tool half is phase 1 of this feature, and the read-only bash and the platform fallback in that item are phase 2. Plan mode becomes one more registrant: while the mode is Plan it asks the layer to treat everything without an `allow` verdict as `never`, and, where phase 2 is available, to run bash under a read-only profile.

## Tests that matter

A list for the implementer:

- A call with no UI is blocked, with the registration choice both ways (`block` and own handler).
- A rule pack that skips the registration choice throws at registration.
- A nested codemode call is gated.
- A nested call from a trusted parent tool is not.
- A tool no rule names asks when it has no `readOnlyHint`, and passes when it has `readOnlyHint` true.
- An unannotated server's read tools pass only when a rule says so.
- A write cannot get past by differing in case, through a `*` pattern, or through a hash-suffixed tool (one with a name over 64 characters and one whose sanitized name collides, such as `a-b` and `a_b` on one server).
- The computed registered name matches pi's for plain, long and colliding names, and a rule that matches no live tool is reported at `session_start`.
- A declined dialog blocks and tells the model not to retry.
- A preview strips control characters and shows the full length of a clipped value.
- The status command reports child coverage as it actually is.

## Questions

1. Where does it live? (decided)
   - Inside pi-chassis. Simplest to ship and shares the registry code. But pi-chassis's package manifest loads the sidebar, header, footer and editor together, and its README says it does not combine with another package that replaces those. Someone who wants only the guard would have to take the TUI.
   - A separate entry in the `pi.extensions` list of the same package, which users can switch off on its own. This still installs the TUI package.
   - A subpath export such as `pi-chassis/guard` for the client side, with the host as a separate extension entry.
   - Its own package, with pi-chassis as one registrant (for Plan mode).

   Decided: its own package, `pi-governor`, with pi-chassis depending on its client for Plan mode. The guard is a safety control and should not need a TUI to run.

2. What happens when no guard host is loaded?
   - The registering package chooses between blocking and its own fallback, in the registration call (the proposal above).
   - The layer always fails closed, and a package that wants its own fallback cannot have one.

   Recommendation: the registering package chooses, with no default. Always failing closed is simpler but takes away the one case where a package has a dialog of its own that already works. The no-default rule keeps the choice visible in the code that makes it.

3. Who covers subagent children?
   - Part of the layer: the layer knows how the host loads extensions into children and arranges for the guard to be present there.
   - Supplied by the host: the host reports whether it loads the guard into children, and the layer reports that through the status command.

   Recommendation: supplied by the host, with the status command reporting it. The layer then does not depend on how any one subagent package works, and a change there cannot silently drop coverage. If the host does not say, the status command reports children as not covered.
