#!/usr/bin/env -S deno run --allow-all

import { Kernel } from "../kernel/kernel.ts";
import { Mode } from "../kernel/types.ts";

async function main() {
  const kernel = new Kernel();
  await kernel.start();

  const objective = Deno.args.join(" ");
  if (objective) {
    await kernel.receiveObjective(objective);
    const config = kernel.getConfig();
    await kernel.executeMode(config.mode, objective);
  }

  await kernel.shutdown();
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
