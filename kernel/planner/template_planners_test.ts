import { assertEquals } from "@std/assert";
import {
  ExplorationPlanner,
  ImplementationPlanner,
  RefactoringPlanner,
  selectPlanner,
} from "./template_planners.ts";
import {
  determineExecutionMode,
  isRelayPattern,
  isScoutPattern,
  isSwarmPattern,
} from "./planner.ts";
import { Mode } from "../types.ts";

Deno.test("ExplorationPlanner creates scout-like graph", async () => {
  const planner = new ExplorationPlanner();
  const graph = await planner.plan({
    objective: "Explore auth module",
    workspace: "/tmp",
  });

  assertEquals(graph.tasks.length, 3);
  assertEquals(graph.tasks[0].dependencies.length, 0);
  assertEquals(isScoutPattern(graph), true);
  assertEquals(determineExecutionMode(graph), Mode.Scout);
});

Deno.test("ImplementationPlanner creates relay-like graph", async () => {
  const planner = new ImplementationPlanner();
  const graph = await planner.plan({
    objective: "Implement auth",
    workspace: "/tmp",
  });

  assertEquals(graph.tasks.length, 3);
  assertEquals(graph.tasks[1].dependencies.length, 1);
  assertEquals(isRelayPattern(graph), true);
  assertEquals(determineExecutionMode(graph), Mode.Relay);
});

Deno.test("RefactoringPlanner requires analysis task", async () => {
  const planner = new RefactoringPlanner();
  const graph = await planner.plan({
    objective: "Refactor auth",
    workspace: "/tmp",
  });

  const validation = await planner.validate(graph);
  assertEquals(validation.valid, true);

  const badGraph = {
    ...graph,
    tasks: graph.tasks.filter((t) => !t.title.includes("Analyze")),
  };
  const badValidation = await planner.validate(badGraph);
  assertEquals(badValidation.valid, false);
});

Deno.test("selectPlanner chooses ExplorationPlanner for exploration objectives", () => {
  const planner = selectPlanner("Explore how the auth module works");
  assertEquals(planner instanceof ExplorationPlanner, true);
});

Deno.test("selectPlanner chooses RefactoringPlanner for refactoring objectives", () => {
  const planner = selectPlanner("Refactor the auth code");
  assertEquals(planner instanceof RefactoringPlanner, true);
});

Deno.test("selectPlanner defaults to ImplementationPlanner", () => {
  const planner = selectPlanner("Add user authentication");
  assertEquals(planner instanceof ImplementationPlanner, true);
});

Deno.test("isScoutPattern detects exploration graphs", async () => {
  const planner = new ExplorationPlanner();
  const graph = await planner.plan({ objective: "Explore", workspace: "/tmp" });

  assertEquals(isScoutPattern(graph), true);
  assertEquals(isRelayPattern(graph), false);
});

Deno.test("isRelayPattern detects sequential graphs", async () => {
  const planner = new ImplementationPlanner();
  const graph = await planner.plan({
    objective: "Implement",
    workspace: "/tmp",
  });

  assertEquals(isRelayPattern(graph), true);
  assertEquals(isScoutPattern(graph), false);
});
