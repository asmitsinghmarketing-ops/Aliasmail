
// START ALIASMAIL
import("./src/index.js").catch((err) => {
  console.error("AliasMail startup error:", err);
  process.exitCode = 1;
});
