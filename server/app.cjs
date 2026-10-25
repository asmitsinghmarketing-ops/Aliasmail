
const net = require("node:net");
const tls = require("node:tls");

async function diagnoseIMAP() {
  const host = process.env.IMAP_HOST || "imap.secureserver.net";
  const port = Number(process.env.IMAP_PORT || 993);

  console.log("[DIAG] Node:", process.version);
  console.log("[DIAG] IMAP target:", host, port);

  // TEST 1: TCP CONNECTION
  await new Promise((resolve) => {
    const socket = net.connect({ host, port });

    socket.setTimeout(10000);

    socket.once("connect", () => {
      console.log("[DIAG] TCP SUCCESS");
      socket.destroy();
      resolve();
    });

    socket.once("timeout", () => {
      console.error("[DIAG] TCP TIMEOUT");
      socket.destroy();
      resolve();
    });

    socket.once("error", (err) => {
      console.error("[DIAG] TCP ERROR:", {
        code: err.code,
        message: err.message,
        syscall: err.syscall,
        address: err.address,
        port: err.port
      });
      resolve();
    });
  });

  // TEST 2: TLS CONNECTION
  await new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true
    });

    socket.setTimeout(10000);

    socket.once("secureConnect", () => {
      console.log("[DIAG] TLS SUCCESS", {
        authorized: socket.authorized,
        protocol: socket.getProtocol()
      });
      socket.destroy();
      resolve();
    });

    socket.once("timeout", () => {
      console.error("[DIAG] TLS TIMEOUT");
      socket.destroy();
      resolve();
    });

    socket.once("error", (err) => {
      console.error("[DIAG] TLS ERROR:", {
        code: err.code,
        message: err.message,
        syscall: err.syscall,
        address: err.address
      });
      resolve();
    });
  });
}

// START ORIGINAL ALIASMAIL APP
import("./src/index.js").catch((err) => {
  console.error("AliasMail failed to start:", err);
  process.exitCode = 1;
});

// RUN DIAGNOSTIC
diagnoseIMAP().catch((err) => {
  console.error("[DIAG] UNEXPECTED ERROR:", err);
});
