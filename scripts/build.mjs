import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
copyFileSync("src/db/schema.sql", "dist/src/db/schema.sql");
