#!/usr/bin/env -S deno run -A --quiet
import { readStdin } from "./lib/stdin.ts";

function outputHookResult(): void {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

async function main(): Promise<void> {
  await readStdin();
  outputHookResult();
}

main();
