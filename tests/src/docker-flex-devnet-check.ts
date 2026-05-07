import { runDockerFlexDevnetCheck } from "./lib/docker-flex-devnet.js";

const result = await runDockerFlexDevnetCheck();

process.stdout.write(JSON.stringify(result, null, 2));
process.stdout.write("\n");
