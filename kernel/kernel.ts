import { EventBus, EventType } from "./events.ts";
import type { KernelEvent } from "./events.ts";
import { ConfigLoader } from "./config.ts";
import { DEFAULT_TRIGGERS, TriggerEngine } from "./triggers.ts";
import { AdapterRegistry } from "./adapters.ts";
import type { KernelConfig, RunContext } from "./types.ts";
import { Mode, RunState } from "./types.ts";
import { OvermindError } from "./errors.ts";
import { createRunContext } from "./modes/shared.ts";
import { CancellationRegistry } from "./cancellation.ts";
import { executeScout } from "./modes/scout.ts";
import { executeRelay } from "./modes/relay.ts";
import { executeSwarm } from "./modes/swarm.ts";
import { PersistenceCoordinator } from "./persistence.ts";
import type { LockRegistry } from "./locks.ts";
import {
  type IntentClassification,
  type InterviewCallback,
  type InterviewResponse,
  KeywordIntentGate,
} from "./planner/intent_gate.ts";
import { selectPlanner } from "./planner/template_planners.ts";
import { determineExecutionMode, type TaskGraph } from "./planner/planner.ts";
import { GapAnalyzer } from "./planner/gap_analyzer.ts";
import { StrictValidator } from "./planner/strict_validator.ts";
import type { AgentDispatcher } from "./agent_dispatcher.ts";

export interface KernelOptions {
  registry?: AdapterRegistry;
  interviewCallback?: InterviewCallback;
  dispatcher?: AgentDispatcher;
  lockRegistry?: LockRegistry;
}

export class Kernel {
  private eventBus: EventBus;
  private configLoader: ConfigLoader;
  private triggerEngine: TriggerEngine;
  private adapterRegistry: AdapterRegistry | null = null;
  private injectedRegistry: AdapterRegistry | null = null;
  private config: KernelConfig | null = null;
  private running = false;
  private cancellationRegistry = new CancellationRegistry();
  private interviewCallback: InterviewCallback | null;
  private dispatcher: AgentDispatcher | null;
  private lockRegistry: LockRegistry | null;

  constructor(options?: KernelOptions) {
    this.eventBus = new EventBus();
    this.configLoader = new ConfigLoader();
    this.triggerEngine = new TriggerEngine();
    this.injectedRegistry = options?.registry ?? null;
    this.interviewCallback = options?.interviewCallback ?? null;
    this.dispatcher = options?.dispatcher ?? null;
    this.lockRegistry = options?.lockRegistry ?? null;
  }

  attachLockRegistry(registry: LockRegistry): void {
    this.lockRegistry = registry;
  }

  getLockRegistry(): LockRegistry | null {
    return this.lockRegistry;
  }

  async start(): Promise<void> {
    if (this.running) throw new OvermindError("Kernel already running");

    const cfg = await this.configLoader.load();
    this.config = this.configLoader.toKernelConfig(cfg);

    for (const trigger of DEFAULT_TRIGGERS) {
      this.triggerEngine.addTrigger(trigger);
    }

    this.adapterRegistry = this.injectedRegistry ?? new AdapterRegistry(this);
    if (!this.injectedRegistry) {
      await this.adapterRegistry.connect();
    }

    this.running = true;
    this.emit(EventType.KernelStarting);
    this.emit(EventType.KernelReady);
  }

  async shutdown(): Promise<void> {
    if (!this.running) return;
    this.emit(EventType.KernelShutdown);
    if (this.adapterRegistry) {
      await this.adapterRegistry.disconnect();
    }
    this.running = false;
  }

  getConfig(): KernelConfig {
    if (!this.config) throw new OvermindError("Kernel not started");
    return this.config;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getTriggerEngine(): TriggerEngine {
    return this.triggerEngine;
  }

  getAdapterRegistry(): AdapterRegistry | null {
    return this.adapterRegistry;
  }

  async receiveObjective(objective: string): Promise<void> {
    if (!this.running) throw new OvermindError("Kernel not running");
    this.emit(EventType.ObjectiveReceived, { objective });
  }

  cancelRun(runId: string): boolean {
    const cancelled = this.cancellationRegistry.cancel(runId);
    // Lock release is best-effort — never block cancel on it. The mode
    // executor's finally block also calls releaseAllForRun, so this is
    // belt-and-suspenders for the case where the executor stays stuck
    // past the cancel signal.
    if (this.lockRegistry) {
      this.lockRegistry.releaseAllForRun(runId).catch((err) => {
        console.error(`Lock release error for run ${runId}:`, err);
      });
    }
    return cancelled;
  }

  async executeMode(
    mode: Mode,
    objective: string,
    workspace = Deno.cwd(),
    runId?: string,
  ): Promise<RunContext> {
    return await this.executeModeImpl(mode, objective, workspace, runId);
  }

  private async executeModeImpl(
    mode: Mode,
    objective: string,
    workspace: string,
    runId?: string,
    graph?: TaskGraph,
  ): Promise<RunContext> {
    if (!this.adapterRegistry) throw new OvermindError("Kernel not started");

    this.emit(EventType.ModeSwitched, { mode });

    const config = this.getConfig();
    const modeSettings = config.modes[mode];
    const maxIterations = modeSettings?.maxFixCycles ?? 3;

    const resolvedRunId = runId ?? `run-${crypto.randomUUID()}`;
    const signal = this.cancellationRegistry.register(resolvedRunId);

    const ctx = createRunContext({
      run_id: resolvedRunId,
      mode,
      objective,
      workspace,
      brain_task_id: "",
      room_id: "",
      max_iterations: maxIterations,
    });

    const ctxWithSignal: RunContext = { ...ctx, signal };

    const brain = this.adapterRegistry.getBrain();
    const neuralLink = this.adapterRegistry.getNeuralLink();
    const persistence = new PersistenceCoordinator(workspace, brain);
    await persistence.startRun(ctxWithSignal);

    try {
      // Resolve dispatcher from explicit option or, failing that, from the
      // adapter registry. This makes AdapterRegistry the single source of
      // truth when no override is supplied at construction time.
      const dispatcher = this.dispatcher ??
        this.adapterRegistry?.getDispatcher() ??
        undefined;
      switch (mode) {
        case Mode.Scout:
          return await executeScout(
            ctxWithSignal,
            brain,
            neuralLink,
            persistence,
            graph,
            dispatcher,
          );
        case Mode.Relay:
          return await executeRelay(
            ctxWithSignal,
            brain,
            neuralLink,
            persistence,
            graph,
            dispatcher,
          );
        case Mode.Swarm:
          return await executeSwarm(
            ctxWithSignal,
            brain,
            neuralLink,
            persistence,
            undefined,
            undefined,
            undefined,
            undefined,
            graph,
            dispatcher,
          );
        default:
          throw new OvermindError(`Unknown mode: ${String(mode)}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await persistence.failRun(
        { ...ctxWithSignal, state: RunState.Failed },
        message,
      );
      throw err;
    } finally {
      this.cancellationRegistry.unregister(resolvedRunId);
      // Release every lock owned by this run. Hooks rely on the kernel for
      // auto-release rather than per-edit unlocks, so this is the canonical
      // cleanup point and runs after every terminal path (success / fail /
      // cancel).
      if (this.lockRegistry) {
        try {
          await this.lockRegistry.releaseAllForRun(resolvedRunId);
        } catch (err) {
          console.error(
            `Lock release error for run ${resolvedRunId}:`,
            err,
          );
        }
      }
    }
  }

  async executeWithPlanner(
    objective: string,
    workspace = Deno.cwd(),
    runId?: string,
  ): Promise<
    { runContext: RunContext; intent: IntentClassification; plannedMode: Mode }
  > {
    if (!this.adapterRegistry) throw new OvermindError("Kernel not started");

    const intentGate = new KeywordIntentGate(
      this.interviewCallback ?? undefined,
    );
    const intent = await intentGate.classify(objective);

    this.emit(EventType.ObjectiveReceived, { objective, intent: intent.type });

    let interviewResponses: InterviewResponse[] | undefined;
    if (intent.requiresInterview) {
      interviewResponses = await intentGate.conductInterview(objective, intent);
    }

    const planner = selectPlanner(objective);
    const planContext = {
      objective,
      workspace,
      interviewResponses,
    };

    const graph = await planner.plan(planContext);

    const gapAnalyzer = new GapAnalyzer();
    const gapAnalysis = gapAnalyzer.analyze(graph, objective);

    if (gapAnalysis.gaps.filter((g) => g.severity === "high").length > 0) {
      console.log("High-severity gaps detected:");
      for (const gap of gapAnalysis.gaps.filter((g) => g.severity === "high")) {
        console.log(`  - ${gap.description}`);
      }
    }

    const validator = new StrictValidator();
    const validation = validator.validate(graph);

    if (!validation.valid) {
      console.log("Plan validation failed:");
      for (
        const issue of validation.issues.filter((i) => i.severity === "error")
      ) {
        console.log(`  - ${issue.message}`);
      }
    }

    const plannedMode = intent.suggestedMode ?? determineExecutionMode(graph);
    this.emit(EventType.ModeSwitched, { mode: plannedMode, planned: true });

    const runContext = await this.executeModeImpl(
      plannedMode,
      objective,
      workspace,
      runId,
      graph,
    );

    return { runContext, intent, plannedMode };
  }

  private emit(type: EventType, payload: Record<string, unknown> = {}): void {
    const event: KernelEvent = { type, timestamp: new Date(), payload };
    this.eventBus.emit(event);
    this.triggerEngine.fire(event).catch((err) => {
      console.error(`Trigger engine error for ${type}:`, err);
    });
  }
}
