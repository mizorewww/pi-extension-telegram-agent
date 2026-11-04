import { copyFileSync } from "node:fs";

for (const path of ["src/db/schema.sql", "src/agent/tool-examples.md"]) {
	copyFileSync(path, `dist/${path}`);
}
