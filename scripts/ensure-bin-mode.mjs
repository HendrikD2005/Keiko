// Ensures npm/Yarn can execute Keiko's bin entry from the published tarball.
// TypeScript emits files with the process umask, so the shebang alone is not enough.

import { chmodSync, existsSync } from "node:fs";

const BIN_PATH = "dist/cli/index.js";

if (!existsSync(BIN_PATH)) {
  console.error(`bin mode check failed: ${BIN_PATH} does not exist. Run npm run build first.`);
  process.exit(1);
}

chmodSync(BIN_PATH, 0o755);
console.log(`bin mode prepared: ${BIN_PATH} is executable.`);
