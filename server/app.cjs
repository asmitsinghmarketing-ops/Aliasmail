
import net from "node:net";
import tls from "node:tls";

async function diagnoseIMAP() {
  const host = process.env.IMAP_HOST || "imap.secureserver.net";
  const port = Number(process.env.IMAP_PORT || 993);

  console.log("[DIAG] Node:", process.version);
  console.log("[DIAG] IMAP target:", host, port);

  // Test 1: TCP connectivity
  await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(10000);

    socket.on("connect", () => {
      console.log("[DIAG] TCP SUCCESS");
      socket.destroy();
      resolve();
    });

    socket.on("timeout", () => {
      console.error("[DIAG] TCP TIMEOUT");
      socket.destroy();
      resolve();
    });

    socket.on("error", (err) => {
      console.error("[DIAG] TCP ERROR", {
        code: err.code,
        syscall: err.syscall,
        address: err.address,
        port: err.port,
        message: err.message,
      });
      resolve();
    });
  });

  // Test 2: TLS handshake
  await new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
    });

    socket.setTimeout(10000);

    socket.on("secureConnect", () => {
      console.log("[DIAG] TLS SUCCESS", {
        authorized: socket.authorized,
        protocol: socket.getProtocol(),
      });
      socket.destroy();
      resolve();
    });

    socket.on("timeout", () => {
      console.error("[DIAG] TLS TIMEOUT");
      socket.destroy();
      resolve();
    });

    socket.on("error", (err) => {
      console.error("[DIAG] TLS ERROR", {
        code: err.code,
        syscall: err.syscall,
        address: err.address,
        message: err.message,
      });
      resolve();
    });
  });
}

diagnoseIMAP().catch((err) => {
  console.error("[DIAG] UNEXPECTED ERROR", err);
});


import('./src/index.js').catch((err) => {
  console.error('AliasMail failed to start:', err);
  process.exit(1);
});