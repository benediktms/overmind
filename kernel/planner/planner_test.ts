import { assertEquals } from "@std/assert";

import { topologicalSort, type TaskGraph, type TaskNode } from "./planner.ts";

function makeNode(id: string, deps: string[] = []): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    agentRole: "probe",
    dependencies: deps,
    acceptanceCriteria: [],
  };
}

Deno.test("topologicalSort returns nodes in valid dependency order", () => {
  const graph: TaskGraph = {
    tasks: [
      makeNode("a"),
      makeNode("b", ["a"]),
      makeNode("c", ["b"]),
    ],
    parallelGroups: [],
    entryPoints: ["a"],
  };

  const sorted = topologicalSort(graph);

  assertEquals(sorted.length, 3);
  assertEquals(sorted[0].id, "a");
  assertEquals(sorted[1].id, "b");
  assertEquals(sorted[2].id, "c");
});

Deno.test("topologicalSort handles graph with no dependencies", () => {
  const graph: TaskGraph = {
    tasks: [
      makeNode("x"),
      makeNode("y"),
      makeNode("z"),
    ],
    parallelGroups: [],
    entryPoints: ["x", "y", "z"],
  };

  const sorted = topologicalSort(graph);

  assertEquals(sorted.length, 3);
  const ids = sorted.map((n) => n.id);
  assertEquals(ids.includes("x"), true);
  assertEquals(ids.includes("y"), true);
  assertEquals(ids.includes("z"), true);
});

Deno.test("topologicalSort handles diamond dependency pattern", () => {
  //   a
  //  / \
  // b   c
  //  \ /
  //   d
  const graph: TaskGraph = {
    tasks: [
      makeNode("a"),
      makeNode("b", ["a"]),
      makeNode("c", ["a"]),
      makeNode("d", ["b", "c"]),
    ],
    parallelGroups: [["b", "c"]],
    entryPoints: ["a"],
  };

  const sorted = topologicalSort(graph);

  assertEquals(sorted.length, 4);

  const indexOf = (id: string) => sorted.findIndex((n) => n.id === id);
  assertEquals(indexOf("a") < indexOf("b"), true);
  assertEquals(indexOf("a") < indexOf("c"), true);
  assertEquals(indexOf("b") < indexOf("d"), true);
  assertEquals(indexOf("c") < indexOf("d"), true);
});

Deno.test("topologicalSort appends cycle nodes instead of dropping them (regression: review-low)", () => {
  const graph: TaskGraph = {
    tasks: [
      makeNode("acyclic"),
      makeNode("a", ["b"]),
      makeNode("b", ["a"]),
    ],
    parallelGroups: [],
    entryPoints: ["acyclic"],
  };

  const sorted = topologicalSort(graph);

  assertEquals(sorted.length, 3);
  assertEquals(sorted[0].id, "acyclic");
  assertEquals(sorted.map((n) => n.id).sort(), ["a", "acyclic", "b"]);
});
