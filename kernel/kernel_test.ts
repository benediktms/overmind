import { assert, assertEquals, assertRejects } from "@std/assert";

import { Kernel } from "./kernel.ts";
import { AdapterRegistry } from "./adapters.ts";
import type { AgentDispatcher } from "./agent_dispatcher.ts";
import { Mode } from "./types.ts";
import { type BrainAdapter } from "../adapters/brain/adapter.ts";
import { type NeuralLinkAdapter } from "../adapters/neural_link/adapter.ts";
import { MockBrainAdapter } from "./test_helpers/mock_brain.ts";
import { MockNeuralLinkAdapter } from "./test_helpers/mock_neural_link.ts";

// Minimal stub that satisfies the AgentDispatcher contract. Tests inject
// these to observe routing without spawning real subprocesses.
function makeStub(): AgentDispatcher & { cancelCalls: string[] } {
  const calls: string[] = [];
  return {
    dispatch: async () => ({ launched: true }),
    isAvailable: () => true,
    cancelRun: (runId: string) => {
      calls.push(runId);
    },
    cancelCalls: calls,
  };
}

Deno.test(
  "Kernel.getDispatcher routes by DispatcherMode and falls back to legacy single-dispatcher",
  async () => {
    const subprocessSpy = makeStub();
    const clientSideSpy = makeStub();
    const legacy = makeStub();

    const kernel = new Kernel({
      dispatchers: {
        subprocess: subprocessSpy,
        client_side: clientSideSpy,
      },
      defaultDispatcherMode: "subprocess",
      dispatcher: legacy,
    });

    // Registry hits — dispatcher_mode picks the registry entry, not the
    // legacy single dispatcher.
    assertEquals(kernel.getDispatcher("subprocess"), subprocessSpy);
    assertEquals(kernel.getDispatcher("client_side"), clientSideSpy);
    // No-arg form uses defaultDispatcherMode.
    assertEquals(kernel.getDispatcher(), subprocessSpy);
    // hasDispatcher reflects the registry contents.
    assertEquals(kernel.hasDispatcher("subprocess"), true);
    assertEquals(kernel.hasDispatcher("client_side"), true);

    // Second kernel: only the legacy single dispatcher, no registry.
    // getDispatcher() falls back to legacy. hasDispatcher returns false
    // for both modes (registry is empty), which is exactly what the
    // daemon's loud-fail path keys on.
    const kernel2 = new Kernel({ dispatcher: legacy });
    assertEquals(kernel2.getDispatcher(), legacy);
    assertEquals(kernel2.getDispatcher("subprocess"), legacy);
    assertEquals(kernel2.hasDispatcher("subprocess"), false);
    assertEquals(kernel2.hasDispatcher("client_side"), false);
  },
);

Deno.test(
  "Kernel.executeMode cleans up cancellation registry when a mode handler throws",
  async () => {
    // Forces the unknown-mode default branch in the switch statement.
    // The throw is inside the try/catch, so persistence.failRun runs and
    // the error re-throws. The finally clause must still execute its
    // cleanup: cancellationRegistry.unregister AND runDispatchers.delete.
    // We observe both via cancelRun's return value (false when neither
    // the cancellation registry nor the runDispatchers map knows the
    // runId — both have to be cleaned up for that to be the case).
    const subprocessSpy = makeStub();
    // Wire mocked adapters so kernel.start() doesn't spawn real MCP
    // child processes (Deno's leak detector flags those at test exit).
    const seed = new Kernel();
    const registry = new AdapterRegistry(seed, {
      brain: new MockBrainAdapter() as unknown as BrainAdapter,
      neuralLink: new MockNeuralLinkAdapter() as unknown as NeuralLinkAdapter,
    });
    const kernel = new Kernel({
      registry,
      dispatchers: { subprocess: subprocessSpy },
      defaultDispatcherMode: "subprocess",
    });
    await kernel.start();

    const runId = "run-cleanup-on-throw";
    const bogusMode = "not-a-real-mode" as unknown as Mode;
    await assertRejects(
      () => kernel.executeMode(bogusMode, "obj", "/tmp", runId),
      Error,
    );

    // After the finally block ran, neither the cancellation registry nor
    // runDispatchers should know about runId. cancelRun returns false
    // because cancellationRegistry.cancel returns false for unknown ids.
    const cancelled = kernel.cancelRun(runId);
    assertEquals(cancelled, false);

    // The dispatcher's cancelRun is best-effort and fired regardless,
    // but the runId should not have been routed via runDispatchers
    // (since that map was cleaned). The dispatcher's cancelRun callback
    // may have been invoked once with this runId via the fallback chain
    // — that's fine; the contract is best-effort cleanup, not "no
    // signal at all". We only assert no leak via cancelled === false.
    assert(
      subprocessSpy.cancelCalls.length <= 1,
      "subprocess dispatcher should be cancelled at most once",
    );

    await kernel.shutdown();
  },
);
