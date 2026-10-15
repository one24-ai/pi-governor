/**
 * Freezing a call's arguments before the guard looks at them.
 *
 * pi hands every `tool_call` handler the same arguments object, and the tool later receives that
 * object. A handler that runs after the guard can edit it in place, so what the user approved (or
 * what a rule checked) is not what the tool gets. Freezing makes such an edit fail: in strict-mode
 * code (every ES module, so every TypeScript extension) the write throws and pi fails the call
 * without running it; in sloppy-mode code the write is silently ignored and the call runs with the
 * arguments that were checked. Either way the tool receives what the guard saw (measured on pi
 * 1.1.0 and 1.2.0, docs/design.md, Findings). A handler that runs before the guard is unaffected:
 * the guard sees its changes.
 *
 * Only plain data can be frozen. `Object.freeze` does not stop a `Map`, `Set` or `Date` from being
 * changed through its methods, cannot freeze a non-empty typed array at all, and leaves a frozen
 * `ArrayBuffer` writable. A Proxy or an accessor can answer differently the second time it is
 * read. So a value like that makes `deepFreeze` throw, and the guard blocks the call: refusing is
 * the fail-closed answer, and `freezeArguments: false` is the way out for someone who needs it.
 * pi clones arguments with `structuredClone` before the handlers run, so model-issued calls only
 * contain plain data, Maps, Sets, Dates and binary data; Proxies, accessors and functions can
 * only come from a tool call another extension makes itself.
 */

import { types } from "node:util";

function refuse(what: string): never {
	throw new TypeError(`the arguments contain ${what}, which cannot be frozen`);
}

function checkKind(node: object): void {
	if (types.isProxy(node)) refuse("a Proxy");
	if (types.isMap(node) || types.isSet(node) || types.isWeakMap(node) || types.isWeakSet(node)) refuse("a Map or Set");
	if (types.isDate(node)) refuse("a Date");
	if (types.isAnyArrayBuffer(node) || ArrayBuffer.isView(node)) refuse("binary data");
}

/**
 * Freeze `root` and everything reachable through its own data properties. Iterative, so a deeply
 * nested value cannot overflow the stack; a cycle is fine. Getters are never called: an accessor
 * property is refused. Throws for anything it cannot make immutable (see the top of this file), so
 * the caller can block the call instead of letting an unfrozen object through. A throw can leave
 * the value partly frozen, which does not matter for a call that is then blocked.
 */
export function deepFreeze(root: unknown): void {
	if (typeof root === "function") refuse("a function");
	if (typeof root !== "object" || root === null) return;
	const seen = new WeakSet<object>();
	const stack: object[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) continue;
		seen.add(node);
		checkKind(node);
		Object.freeze(node);
		if (!Object.isFrozen(node)) refuse("an object that refuses to be frozen");
		for (const key of Reflect.ownKeys(node)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(node, key);
			if (!descriptor) continue;
			if (descriptor.get || descriptor.set) refuse("an accessor property");
			const value = descriptor.value;
			if (typeof value === "function") refuse("a function");
			if (typeof value === "object" && value !== null) stack.push(value);
		}
	}
}
