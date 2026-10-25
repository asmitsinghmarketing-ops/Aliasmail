
import net from "node:net";

import("./src/index.js").catch((err) => {
  console.error("AliasMail failed to start:", err);
  process.exit(1);
});

