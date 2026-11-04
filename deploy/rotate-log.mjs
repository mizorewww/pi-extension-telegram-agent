import { closeSync, openSync } from "node:fs";
import { rotateLogFile } from "../dist/src/observability/log.js";
rotateLogFile("/var/lib/pi-telegram-agent/daemon.log");
closeSync(openSync("/var/lib/pi-telegram-agent/daemon.log", "a", 0o600));
