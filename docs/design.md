# pi-governor design

Status: phase 1 is implemented (registry and client, the guard host, the approval dialog, the status command); phase 2 is not. pi-governor is a guard layer for pi tool calls, built in two phases: rules for every tool call first, then an optional OS sandbox for bash (see "Phase 2: a bash sandbox"). It started as a proposal in [pi-chassis](https://github.com/one24-ai/pi-chassis), whose Plan mode is its first planned registrant. File paths under `extensions/chassis/` below refer to the pi-chassis repo.

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
- An optional narrowing by arguments (for example, only when a given field has a given value). When the input is not a plain object, an `ask` or `never` rule still applies and an `allow` rule does not.
- An optional predicate, `when(args)`, for what equality cannot say. It is synchronous and runs on the arguments after they were frozen (see "Care needed"), together with the argument narrowing (both must hold). It is not called for input that is not a plain object. Only a strict `true` is a match and a strict `false` is no match; a throw, a Promise or any other value is unusable, and an unusable answer counts as a match for `ask` and `never` (stricter) and as no match for `allow` (an allow must never apply by accident). The client fallback uses the same function, so it behaves the same without a host.
- A verdict: `allow`, `ask` or `never`.
- For `never`, an optional `reason` (1 to 500 characters), added to the block message after the instruction not to retry; the first deciding rule that has one supplies it. For `ask`, an optional `title` (1 to 100 characters) for the dialog. Both are rejected on the other verdicts, and both go through `visible()` and clipping, like every string that reaches the model or the dialog.
- For `ask`, a `preview(args)` that returns the text the dialog shows, so the user sees the exact values that would be sent.
- For `ask`, an optional approval window. Without one, every call asks. The approval key is the tool plus the ids of the deciding rules, so a windowed rule with a predicate approves every call it matches for the window, not one per argument value.

### Default for tools no rule names

Each tool falls into one of four sources, and each source has a default verdict. The defaults are set in config (see "Config") and can be `allow`, `ask`, `never` or `hints`. `hints` means: pass when the tool declares `readOnlyHint` true, ask otherwise.

| Source | How the layer tells | Shipped default |
|---|---|---|
| `mcp` | the registered name or the tool's `namespace` starts with `mcp__` | `hints` |
| `builtin` | the name is one of pi's built-in tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) and `sourceInfo.path` in `pi.getAllTools()` is `builtin:<tool name>` | `allow` |
| `extension` | any other tool `pi.getAllTools()` lists | `allow` |
| `unknown` | a tool `pi.getAllTools()` does not list when the call arrives | `ask`, not configurable |

Read from pi's source (1.1.0, and unchanged in 1.2.0 where checked), not measured: built-in tools get the synthetic `sourceInfo` `builtin:<name>`, and an extension that registers a tool under a built-in's name (for example its own `bash`) replaces the definition and its `sourceInfo`, so it counts as `extension`. pi's own built-in extensions (`codemode`, `tool_search`, the MCP resource tools) count as `extension`. They also have `builtin:<name>` paths, and `builtin:codemode` registers a tool named `codemode`, which is why the path alone is not enough. The nested calls `codemode` makes are classified on their own. MCP tools registered by an adapter extension instead of pi's built-in MCP still count as `mcp` because of their name, so the stricter default applies.

Only MCP tools and the MCP resource tools carry annotations in pi 1.1.0 and 1.2.0 (read from source; the 1.2.0 listing in the probe showed the same): built-in tools, `codemode` and extension tools have none. That is why `hints` is the shipped default for `mcp` only. Strict setups (Plan mode, or a user who wants every write confirmed) set `builtin` or `extension` to `ask` or `hints`.

Annotations are declared by the server and pi does not verify them. They are a default, not a boundary. A `never` or `ask` rule always wins over a hint, and over a source default. An `allow` rule wins over a source default too, including one a project file tightened: rules come from installed packages, not from the project folder, and that is how a pack marks an unannotated server's read tools as safe.

### Config

The source defaults are read from `~/.pi/agent/governor.json` (global) and `.pi/governor.json` (project). pi reads project files only after the user trusts the project, but trust does not make their content safe, so the project file may only tighten: for each source the stricter of the two values applies, in the order `allow` < `hints` < `ask` < `never`. A config file that cannot be read or parsed is reported by the status command, and every source is raised to at least `ask` until it is fixed (a source already at `never` stays `never`).

### One dialog, one fail-closed path

Every `ask` rule goes through the same dialog and the same failure behaviour. Dialogs open one at a time, and a call queued behind one does not open its own after the operation was aborted. With no UI (print mode, a subagent child) an `ask` call is blocked, and the reason tells the model to ask the user instead.

`ctx.hasUI` is not enough to detect a missing UI. In RPC mode it is true even when no client is attached, and a dialog then waits for an answer that never comes. So every dialog is opened with a timeout, and a timeout counts as a decline. The guard also stops waiting a few seconds after that timeout, so a UI that ignores it cannot stall every later ask; that call is blocked as unanswered.

A declined dialog also blocks, and the reason tells the model not to retry the call. A timed-out dialog blocks with a reason that says nobody answered.

### Approval windows

Approvals last a window only when a rule asks for one. The default for a write is to ask every time, because each payload differs and the preview is the point. A window suits cases where the payload is not what the user is approving, for example a series of reads against a tool that is not marked read-only.

### Nested calls

An `ask` rule applies to calls that a codemode script or another tool makes. A rule can name parent tools that are trusted to have asked already, for example a tool that has its own confirm dialog. A nested call from such a parent skips the guard's dialog; every other nested call is gated like a top-level one.

### Registration and the missing-host case

Packages register with the guard the way pi-chassis's widget client registers with pi-chassis (`extensions/chassis/client.ts` in pi-chassis): through a `Symbol.for` registry on `globalThis`. The widget client looks for the `pi-halo/registry` key, checks `apiVersion`, queues the registration under `pi-halo/pending` when the host has not loaded yet, and when the host never appears falls back at `session_start`. `extensions/chassis/api.ts` is the host side: it sets `apiVersion` on the registry and takes over the queued registrations when it loads. The guard uses the same shape under `pi-governor/registry` and `pi-governor/pending`, so load order does not matter. It differs in four ways:

- **The version must match exactly.** A client registers only with a store whose `apiVersion` equals its own. A host that finds a store with another version throws at load. Nothing is assumed to understand an older client.
- **Several hosts share one store.** A subagent child can run inside its parent's process and load its own copy of the host. Every host reads the same registered rules, and the store ends with the last host, at which point each package is told and its `whenNoHost` choice is back in force.
- **A host in the process is not a host in the session.** A host marks the sessions it has a `tool_call` handler in (by their session manager). A package's own fallback keeps running in any session the host has not marked, so a child without the host handler is not treated as covered.
- **Rules belong to the package that registered them.** A package registering again replaces its own earlier rules. Another package using the same id is kept alongside, not substituted: nobody can loosen another package's rules by reusing its name. Rules are validated and frozen when registered, so later edits to the originals, or a getter that answers differently the second time, do not reach the guard.

The fallback is where the guard and a widget differ most. The widget client's fallback with no pi-chassis is a status line (`ctx.ui.setStatus`), which is harmless. The same kind of fallback for a guard would let writes through with nobody asking.

So the registering package must choose in the registration call, with no default:

- `whenNoHost: "block"`: the tools its ask and never rules cover are blocked until a guard host is present. Allow rules need no enforcing without a host.
- `whenNoHost: <handler>`: the package installs a minimal `tool_call` handler of its own for those tools. A handler that throws blocks the call.

A rule pack that skips the choice fails loudly at registration (it throws), rather than discovering the gap at `session_start`. The option name is `whenNoHost` in `registerRules(pi, { id, rules, whenNoHost })`, exported from `pi-governor/client`.

### Status command

`/governor` lists the live rule packs and their rules, the source defaults and the state of both config files (a broken file is named as broken), the rules that match no live tool, the live approvals with their time left, and whether this session has a guard handler of its own. It says plainly that subagent children are not known to be covered and that the order of `tool_call` handlers across extensions has not been measured, instead of claiming either. `/governor revoke` drops every live approval and says how many; any other argument prints a usage line instead of the status. A rule with a predicate is listed as having one, with no text for it. A rule that matches no live tool is explained differently before and after any MCP tool is listed, because MCP servers connect in the background.

## Findings

Re-verified on 2026-10-09 against pi 1.1.0 (`@earendil-works/pi-coding-agent`), in print mode, RPC mode and a pi-subagents foreground child, using a probe extension and a local MCP server with tools named to trigger each naming case. Items marked as read from source or types were checked in pi's `dist` files, not measured. Re-verify against the pi version this package's `peerDependencies` names whenever that changes.

Re-measured on 2026-10-14 against pi 1.2.0, which is the pi installed and the range in `peerDependencies`. Reproduced: nested calls carry `parentToolCallId` with ids `<parent>/<n>`; `ctx.mode` is `"print"` with `hasUI` false in print mode; in RPC mode `hasUI` is true and `ctx.ui.confirm(..., { timeout: 3000 })` resolved false after 3001 ms with nobody answering; `pi.getAllTools()` lists no MCP tools at `session_start` and seven by the first `tool_call`; annotations pass through as declared; the hash suffixes match SHA-256 computed independently (`a_b_5cedebc2`, `a_b_795d8c8f`, the 70-character name `_7f18c2c9`); and the handler-order result below. One result differed: the cross-server collision went the other way (see below). Changes in 1.2.0 that touch this package: tool namespaces gained `aliases` (the server name), which the governor does not use, and tool definitions gained `reachesTools`. Nothing checked required a code change.

- `tool_call` handlers fire for every MCP call, including calls that a codemode script or another tool makes. Those events carry `parentToolCallId`, and nested ids look like `<parent id>/<n>`. The parent's `tool_execution_start` event carries its tool name, so a guard can learn which tool made a nested call.
- A `{ block: true, reason }` from a `tool_call` handler on a nested call reaches the codemode script as a thrown error carrying the reason.
- In print mode `ctx.hasUI` was false and `ctx.mode` was `"print"`. A pi-subagents foreground child also ran with `mode` `"print"` and `hasUI` false.
- In RPC mode with no client answering, `ctx.mode` was `"rpc"` and `ctx.hasUI` was true. `ctx.ui.confirm(..., { timeout: 3000 })` emitted an `extension_ui_request` and resolved false after 3 seconds. Without a timeout it would wait indefinitely (read from `docs/rpc-extension-ui.md`, not measured).
- `pi.getAllTools()` lists no MCP tools at `session_start`, `before_agent_start` or the first `turn_start`. MCP servers connect in the background, and their tools appear once connected; by the first `tool_call` they were listed. Anything that inspects live MCP tools has to run later, on `mcp_servers_change` or when a call arrives.
- A tool with no annotations has no `annotations` key in `pi.getAllTools()`; declared hints are passed through as the server sent them.
- Annotations differ by server. `pi.getAllTools()` reported, for one issue-tracker server, all 20 tools annotated (14 with `readOnlyHint` true, the 6 writes false). For one chat server it reported 18 annotated (12 read-only). For one deployment-control server it reported 22 tools with none annotated. codemode's `ALL_TOOLS` does not carry annotations; only `pi.getAllTools()` does.
- Read from pi's type declarations, not measured: a `tool_call` handler receives an `ExtensionContext`, and only the context a running tool's `execute()` receives (`ExtensionToolContext`) has `executeTool()`. So a handler cannot call tools, and a preview cannot look anything up. A transition that takes an id can show the status name only if the session already read the transitions.
- `pi.getAllTools()` gives each MCP tool a `namespace` (for example `mcp__tracker` for `mcp__tracker__create_issue`), an `annotations` object and an `exposure`. Read from pi's source, not measured: the namespace is `mcp__<server>` with only `-` replaced by `_`, while tool names replace every character other than letters, digits and underscore, so the two can disagree for server names with other characters. Measured: a tool `p__q` on server `srv-a` reported namespace `mcp__srv_a`, while tool `q` on server `srv_a__p` reported `mcp__srv_a__p`, although both tools sanitize to `mcp__srv_a__p__q`.
- Read from pi's source (`createMcpToolName` in its MCP extension), not measured: the registered name is `mcp__<server>__<tool>` sanitized as above. When that is longer than 64 characters, or already taken by a different MCP tool, pi cuts it and appends `_` plus the first 8 hex characters of SHA-256 over `<server>\0<tool>` (the original names). The suffix itself is deterministic. Measured: a 70-character tool name, and both `a-b` and `a_b` on one server, got suffixes that matched SHA-256 computed independently. Within one server every tool in a collision gets the suffix, not only the later one (`registerTools` in pi's MCP extension).
- Measured: a collision across servers suffixes only one side. With `srv-a`/`p__q` and `srv_a__p`/`q`, the `srv_a__p` tool kept `mcp__srv_a__p__q` and the `srv-a` tool got `mcp__srv_a__p__q_13e746a6`. Which side keeps the plain name depends on which server registered first (read from source: `toolOwners` is filled as servers connect), so it cannot be computed from the names alone. Measured again on pi 1.2.0 with the same two servers: this time `srv-a`/`p__q` kept `mcp__srv_a__p__q` and `srv_a__p`/`q` got `mcp__srv_a__p__q_008fe00f`, the reverse of the 1.1.0 run. So the winner changes from run to run, and a rule must never assume which side it is.
- pi core ships `examples/extensions/permission-gate.ts`, the same pattern for a few bash commands, with nothing configurable.
- A downstream brand package already has a `tool_call` guard with an ask dialog, fail-closed behaviour without a UI, a 15-minute approval window and a status command. Its rules are hardcoded and another package cannot add one. That is the shape this proposal would make shareable.

- Measured with two probe extensions (a mutator that sets `event.input.text` in place, and a rule that is `never` for `text: "danger"`), on pi 1.1.0, and repeated on 1.2.0 with the same three results (guard then mutator: the tool received `danger`; mutator then guard: blocked; a freezer between them: the later write threw):
  - Handlers run in load order, and a block stops the rest. With the guard loaded first and the mutator after, a call with `text: "safe"` passed the guard and the tool received `text: "danger"`, for a nested codemode call and for a direct top-level call. `tool_result` shows the changed input, so it is visible afterwards but not preventable there.
  - With the mutator loaded first, the guard saw `danger` and blocked it. A handler loaded before the guard is safe; one loaded after is not.
  - The guard cannot re-check later: in the agent loop (`prepareToolCall`) the `tool_call` handlers are the only hook before execution, and `tool_execution_start` fires before the arguments are prepared, so it carries the model's original arguments.
  - Deep-freezing `event.input` in a handler that runs first made a later in-place write throw (`Cannot assign to read only property`), which pi turned into a failed call that did not run. So freezing turns the silent change into a blocked call, but it also breaks any extension that patches arguments on purpose, and it was not checked whether a built-in tool writes to its own arguments.
  - Not checked: how installed packages order against `-e` paths beyond what pi's `mergePaths` shows (CLI paths first, then settings), and whether `event.input` can be replaced rather than mutated (the event wraps the validated arguments, so reassigning looks ineffective, not verified).

Not measured: background (async) subagent children, MCP tools inside a child (none registered in the measured child), and any pi version other than 1.1.0 and 1.2.0. TUI mode was run by hand for the status command and the dialog (arrow-key selection of No, the timeout expiring, and approval windows were not exercised).

## Care needed

A missing guard must not mean ungated. This is the reason for the registration choice. A rule pack that is installed without its host must either block what it covers or carry its own handler, and it must say which when it registers. There is no default that is safe in both directions.

Argument changes after the check. A `tool_call` handler loaded after the guard can change a call's arguments in place, and the tool receives the change (see Findings). A rule that narrows by argument value, and an approval that showed specific values, are only as good as the arguments that are sent. pi gives an extension no way to choose or see its position in the handler order (no priority option, no load-last, no API that lists extensions or handlers; checked in 1.2.0's types and loader), so the guard cannot rely on loading last, and a note asking users to do so would not be a control.

Decided: the guard freezes `event.input` (deeply, without calling getters, with an iterative walk so a very deep value cannot overflow the stack) for every call, before it decides anything and before the first `await`. Freezing first matters: a handler that kept a reference to the arguments could otherwise change them while an approval dialog was open, and the user would approve values the tool does not get (a reviewer found this window). A blocked call is frozen too, which costs nothing because it never runs. A call whose arguments cannot be frozen is blocked, before any rule or dialog. A later in-place write in strict-mode code (every ES module) throws, which pi reports as a failed call that did not run; in sloppy-mode code the write is silently ignored and the call runs with the checked arguments, so the control holds either way but "the call fails" is only true for strict-mode writers (measured: a frozen object, written from a strict function and from a sloppy one). A handler loaded before the guard is unaffected, because the guard checks its changes.

`Object.freeze` is not enough for every value, so `deepFreeze` refuses what it cannot make immutable, and the guard blocks the call: a `Map`, `Set` or `Date` (still changeable through its methods once frozen; measured), a typed array or `Buffer` (a non-empty one cannot be frozen at all; an `ArrayBuffer` stays writable once frozen; measured), a Proxy, an accessor property and a function. pi clones the arguments with `structuredClone` before the handlers run (read from `validateToolArguments` in 1.2.0), so a model-issued call holds plain data, Maps, Sets, Dates and binary data and no Proxies, accessors or functions; only a call another extension makes through `executeTool` can carry those. Measured on pi 1.2.0 over RPC with a handler that kept a reference to a write tool's arguments and wrote to them 1.5 s later, while the approval dialog was open for about 4 s: with freezing on the write threw and the tool received the approved text; with `freezeArguments: false` the write succeeded and the tool received the changed text. A CommonJS (sloppy-mode) handler loaded after the guard wrote `danger`; the write was ignored and the tool received `safe`. Cost, measured on this machine: a 1,000,000-element array of numbers takes about 0.25 s to freeze, 5,000,000 about 1.9 s, and 200,000 small objects about 0.18 s; a 20 MB string is instant. There is no size cap, so a model-issued argument that large would stall the handler for that long. Measured on pi 1.2.0 with a direct MCP call: guard, then mutator: the tool call failed with `Cannot assign to read only property 'text'`; mutator, then guard: the rule blocked `danger`; with `freezeArguments: false` the tool received `danger` after `safe` was checked.

The cost is an extension that edits arguments on purpose breaks, with a "read only property" error that does not name the guard. A search of the extensions in the author's own setup (about a dozen packages and local extensions, including pi-chassis, pi-subagents, pi-web-access and pi's built-in extensions) found none that write to `event.input`; that was a pattern search, so a write through an alias or helper could be missed, and it says nothing about extensions you have installed. pi's `edit` tool normalises its own arguments, but that runs before the `tool_call` handlers. `freezeArguments` in governor.json turns it off; only the global file can, a project file can only turn it on, and a broken file keeps it on. `/governor` shows the setting, and when it is off says the gap is open.

Not covered: freezing applies to calls the guard lets through, not to a tool call another extension makes itself, and a malicious extension runs with the user's permissions and can bypass any of this.

Subagent children. Whether a child is covered depends on how the host loads extensions into children, which is not something a rule can see. In the measured pi-subagents foreground child, the probe extension loaded only because the agent listed it in `extensions`; pi-subagents' docs say foreground children never load the parent's ambient extensions. The layer either carries that coupling (and so knows how the host does it) or the host supplies it. Either way the status command must say plainly which, and whether children are covered right now. A guard that looks covered in children but is not is worse than none, because the user stops watching. A child with no UI blocks every `ask` call, which is safe but will stall a child that needs a write, and the reason should say so.

Dialog text is built from untrusted arguments. Control characters (including escape sequences), bidi controls and characters that render as nothing (zero-width joiners, variation selectors, tag characters, fillers) are replaced by `<U+XXXX>` markers rather than dropped, so the dialog shows what is sent. When a value is clipped, show its full length. A preview must never hide what is actually sent. A rule's own `preview(args)` is shown, followed by a list of every argument the text does not demonstrably contain. A short or generic value counts as shown only when the preview also names its argument, because the model controls other arguments that feed the preview and a bare substring match proves nothing. If a preview fails, the full argument list is shown instead.

Match on the name pi registers. Do not match on the server's own tool name or on a display label. Matching is exact and case-sensitive on the registered name, and `*` patterns are the only wildcard. A rule should be able to name a server and a tool by their original names. The layer computes both candidate names the way pi does: the sanitized name, and the sanitized name with the hash suffix. Length alone decides some cases, but a collision (within a server, or across servers) decides others, and which side of a cross-server collision keeps the plain name depends on connect order. So a computed name is a candidate, not an answer:

- A rule by original names matches a call whose registered name equals either candidate. Matching the suffixed form too means a write cannot escape a rule by colliding.
- If the plain candidate is held by a different server's tool, the rule must not match it. The owning server is known from the tool's `namespace` in `pi.getAllTools()`, which is unique per server because pi rejects servers whose namespaces clash (read from source: `config.js`). This uses `namespace` only to identify the server, never to build a tool name. `ToolInfo` carries no label or original tool name. When the layer cannot tell which tool owns a plain name, it fails closed: it applies the stricter verdict of the rules involved.
- MCP tools are not listed yet at `session_start`. The check that reports rules matching no live tool runs on `mcp_servers_change` and again when a call arrives, and the status command shows rules still unmatched.
- A `*` pattern written against the unsuffixed form can miss a suffixed name, so `ask` and `never` patterns are matched against both the registered name and the registered name with any `_<8 hex>` suffix removed. `allow` patterns match the registered name only: the stripped form could name a different tool whose real name ends in `_` and 8 hex characters. Do not build tool names from `namespace`, which sanitizes differently. The algorithm is pi's, not a public API, so the layer pins it with tests against the pi version it supports.

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
- In RPC mode with no client, an `ask` call blocks when the dialog times out, and the reason says nobody answered.
- A rule pack that skips the registration choice throws at registration.
- A nested codemode call is gated.
- A nested call from a trusted parent tool is not.
- With the shipped config, an MCP tool no rule names asks when it has no `readOnlyHint`, and passes when it has `readOnlyHint` true.
- An unannotated server's read tools pass only when a rule says so.
- Classification: a built-in tool is `builtin`; an extension's override of a built-in name is `extension`; an adapter's `mcp__` tool is `mcp`; a tool `pi.getAllTools()` does not list asks.
- Config: each source default takes effect; a project file can tighten but never loosen a global value; an unreadable config falls back to asking.
- A write cannot get past by differing in case, through a `*` pattern, or through a hash-suffixed tool (one with a name over 64 characters and one whose sanitized name collides, such as `a-b` and `a_b` on one server).
- The computed registered name matches pi's for plain, long and colliding names, including both tools of a same-server collision and the suffixed side of a cross-server collision.
- A rule written for one server never matches the other server's tool in a cross-server collision, whichever side kept the plain name.
- A rule that matches no live tool is reported once MCP servers have connected, not at `session_start`.
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
