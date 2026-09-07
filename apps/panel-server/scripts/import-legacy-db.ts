import { importLegacyDatabase } from "../database/sqlite/legacyImport.ts";

function readOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

const args = process.argv.slice(2);
const sourcePath = readOption(args, "--source");
const targetPath = readOption(args, "--target");
const apply = args.includes("--apply");

if (!sourcePath || !targetPath) {
  console.error("Usage: pnpm --filter @better-zcp/panel-server db:import -- --source /path/db.json --target /path/db.sqlite [--apply]");
  process.exitCode = 2;
} else {
  try {
    const result = await importLegacyDatabase({ sourcePath, targetPath, apply });
    console.log(JSON.stringify(result, null, 2));
    if (!apply) {
      console.log("Dry run only. Add --apply after reviewing this summary.");
    }
  } catch (error: any) {
    console.error(`Import failed: ${error.message}`);
    process.exitCode = 1;
  }
}
