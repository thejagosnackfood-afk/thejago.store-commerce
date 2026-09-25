import { readFile } from "node:fs/promises";
import { planStockUpdates } from "./stock.ts";

function usage() {
  console.error("Usage: node integrations/shopee/plan.mjs <snapshot.json> <mapping.json> [reserve]");
  process.exitCode = 2;
}

if (process.argv.length < 4 || process.argv.length > 5) {
  usage();
} else {
  try {
    const [, , snapshotPath, mappingPath, reserveArg = "0"] = process.argv;
    if (!/^(0|[1-9][0-9]*)$/.test(reserveArg)) {
      throw new Error("Reserve must be a non-negative integer");
    }
    const [stocks, mappings] = await Promise.all([
      readFile(snapshotPath, "utf8").then(JSON.parse),
      readFile(mappingPath, "utf8").then(JSON.parse),
    ]);
    if (!Array.isArray(stocks) || !Array.isArray(mappings)) {
      throw new Error("Both input files must contain JSON arrays");
    }
    const result = planStockUpdates(stocks, mappings, Number(reserveArg));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.skipped.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
