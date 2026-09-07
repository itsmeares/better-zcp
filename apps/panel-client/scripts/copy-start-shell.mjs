import { copyFileSync } from "node:fs";

copyFileSync("dist/_shell.html", "dist/index.html");
