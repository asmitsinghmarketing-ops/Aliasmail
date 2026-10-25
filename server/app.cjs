
const net = require("node:net");
const tls = require("node:tls");

const host = process.env.IMAP_HOST || "imap.secureserver.net";
const port = Number(process.env.IMAP_PORT || 993);

console.log("[DIAG] Node version:", process.version);

// IMAP TCP TEST
function testIMAP() {
  const socket = net.connect({ host, port });

  socket.setTimeout(10000);

  socket.on("connect", () => {
    console.log("[DIAG] TCP SUCCESS");
    socket.destroy();
  });

  socket.on("error", (err) => {
    console.error("[DIAG] TCP ERROR", {
      code: err.code,
      message: err.message,
      syscall: err.syscall
    });
  });

  socket.on("timeout", () => {
    console.error("[DIAG] TCP TIMEOUT");
    socket.destroy();
  });
}

// START ALIASMAIL
import("./src/index.js").catch((err) => {
  console.error("AliasMail startup error:", err);
  process.exitCode = 1;
});

// RUN DIAGNOSTIC
testIMAP();
