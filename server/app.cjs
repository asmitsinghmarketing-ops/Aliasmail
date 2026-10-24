// Startup file for hosts that load apps with require() (cPanel "Setup Node.js App" / Passenger).
// The app itself is an ES module, so load it with a dynamic import.
import('./src/index.js').catch((err) => {
  console.error('AliasMail failed to start:', err);
  process.exit(1);
});
