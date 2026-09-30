import path from "node:path";
import dotenv from "dotenv";

async function main() {
  if (typeof process.pkg !== "undefined") dotenv.config({ path: path.join(path.dirname(process.execPath), ".env") });
  if (typeof process.pkg === "undefined" || process.argv.includes("--panel-child") || process.argv.includes("--reset-password")) {
    await import("./index.ts");
  } else {
    const { bootNativePanel } = await import("./services/panelSupervisor.ts");
    await bootNativePanel();
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
