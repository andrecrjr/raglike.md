import pino from "pino";
import * as fs from "fs";
import * as path from "path";

const logDir = path.join(process.cwd(), ".logs");
const logFile = path.join(logDir, "app.log");

function getTransport() {
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    // Try to open/create the file to check for permissions
    const fd = fs.openSync(logFile, "a");
    fs.closeSync(fd);
    return pino.destination(logFile);
  } catch (e) {
    return pino.destination(1); // STDOUT
  }
}

export const logger = pino({
  level: process.env.PINO_LOG_LEVEL || "info",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
}, getTransport());
