import { existsSync } from "node:fs";

if (
  process.env.NODE_ENV === "production" ||
  process.env.npm_config_production === "true" ||
  process.env.CI === "true" ||
  process.env.HUSKY === "0" ||
  !existsSync(".git")
) {
  process.exit(0);
}

const { default: husky } = await import("husky");
console.log(husky());
