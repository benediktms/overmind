import { assertEquals, assertThrows } from "@std/assert";
import { CancellationError, CancellationRegistry, throwIfAborted } from "./cancellation.ts";

Deno.test("CancellationRegistry.register returns an AbortSignal", () => {
  const registry = new CancellationRegistry();
  const signal = registry.register("run-1");

  assertEquals(signal instanceof AbortSignal, true);
  assertEquals(signal.aborted, false);
  assertEquals(registry.isRegistered("run-1"), true);
});

Deno.test("CancellationRegistry.cancel aborts the signal and returns true", () => {
  const registry = new CancellationRegistry();
  const signal = registry.register("run-2");

  const result = registry.cancel("run-2");

  assertEquals(result, true);
  assertEquals(signal.aborted, true);
  assertEquals(registry.isRegistered("run-2"), false);
});

Deno.test("CancellationRegistry.cancel returns false for unknown runId", () => {
  const registry = new CancellationRegistry();

  const result = registry.cancel("run-unknown");

  assertEquals(result, false);
});

Deno.test("CancellationRegistry.unregister removes the controller", () => {
  const registry = new CancellationRegistry();
  const signal = registry.register("run-3");

  registry.unregister("run-3");

  assertEquals(registry.isRegistered("run-3"), false);
  // Signal should not be aborted — unregister just removes, does not cancel
  assertEquals(signal.aborted, false);
});

Deno.test("throwIfAborted is a no-op when signal is undefined", () => {
  throwIfAborted(undefined);
});

Deno.test("throwIfAborted is a no-op when signal is not yet aborted", () => {
  const controller = new AbortController();
  throwIfAborted(controller.signal);
});

Deno.test("throwIfAborted throws CancellationError when signal is aborted", () => {
  const controller = new AbortController();
  controller.abort();
  assertThrows(() => throwIfAborted(controller.signal), CancellationError);
});
