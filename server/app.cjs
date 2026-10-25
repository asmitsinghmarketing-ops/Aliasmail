
import net from "node:net";

import("./src/index.js").catch((err) => {
  console.error("AliasMail failed to start:", err);
  process.exit(1);
});

// Temporary IMAP connectivity test
const socket = net.createConnection({
  host: "imap.secureserver.net",
  port: 993,
});

socket.setTimeout(8000);

socket.on("connect", () => {
  console.log("[IMAP TEST] TCP connection succeeded");
  socket.end();
});

socket.on("error", (err) => {
  console.error("[IMAP TEST] Failed:", err.code, err.message);
});

socket.on("timeout", () => {
  console.error("[IMAP TEST] Timed out");
  socket.destroy();
});
