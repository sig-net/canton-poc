import { createRequire } from "node:module";

// Test ESM import
const esm = await import("./dist/index.mjs");
console.assert(typeof esm.CantonClient !== "undefined", "ESM: CantonClient missing");
console.assert(typeof esm.buildTxRequest !== "undefined", "ESM: buildTxRequest missing");

// Test CJS require
const require = createRequire(import.meta.url);
const cjs = require("./dist/index.cjs");
console.assert(typeof cjs.CantonClient !== "undefined", "CJS: CantonClient missing");
console.assert(typeof cjs.buildTxRequest !== "undefined", "CJS: buildTxRequest missing");

console.log("ESM and CJS OK");
