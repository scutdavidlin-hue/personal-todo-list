import { startSyntheticConfirmationDemo } from "../demo/confirmation-ui/server.mjs";
const port = Number(process.argv[2] || 4176);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Expected a local port number");
const demo = await startSyntheticConfirmationDemo({ port });
console.log(`SYNTHETIC DEMO ONLY: ${demo.baseURL} — fake identity/tasks, memory only; no real Auth/Google or ChatGPT provenance.`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await demo.close(); process.exit(0); });
