#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return result;
}

function resolveSetting(envMap, name) {
  const envValue = process.env[name];
  if (envValue && envValue.trim()) return envValue.trim();
  if (envMap[name] && envMap[name].trim()) return envMap[name].trim();
  throw new Error(`Missing required setting: ${name}`);
}

function optionalSetting(envMap, name) {
  const envValue = process.env[name];
  if (envValue && envValue.trim()) return envValue.trim();
  if (envMap[name] && envMap[name].trim()) return envMap[name].trim();
  return null;
}

const projectId = readArg("project", "thejagosnackfood-420");
const envFile = readArg("env-file", ".env");
const deployOnly = readArg("only", "functions:shopeeConsole");
const envMap = readEnvFile(path.resolve(rootDir, envFile));

if (deployOnly.includes("hosting") && !hasFlag("allow-hosting")) {
  console.error(
    [
      "Refusing to deploy Hosting from API_shopee by default.",
      "This folder only contains Shopee rewrites and an empty public directory.",
      "Merge the /shopee rewrites into the existing dasboardmarket hosting config instead.",
      "If you really intend to deploy this hosting config, rerun with --allow-hosting.",
    ].join("\n"),
  );
  process.exit(1);
}

const lines = [
  ["SHOPEE_PARTNER_ID", resolveSetting(envMap, "SHOPEE_PARTNER_ID")],
  ["SHOPEE_PARTNER_KEY", resolveSetting(envMap, "SHOPEE_PARTNER_KEY")],
  ["SHOPEE_REDIRECT_URL", resolveSetting(envMap, "SHOPEE_REDIRECT_URL")],
  ["SHOPEE_REGION", optionalSetting(envMap, "SHOPEE_REGION") || "GLOBAL"],
];

for (const key of [
  "GINEE_APP_KEY",
  "GINEE_APP_SECRET",
  "GINEE_SHOP_ID",
  "SHOPEE_SHOP_ID",
  "SHOPEE_ACCESS_TOKEN",
  "SHOPEE_REFRESH_TOKEN",
  "SHOPEE_TOKEN_EXPIRE_IN",
  "SHOPEE_TOKEN_EXPIRED_AT",
  "SHOPEE_MERCHANT_ID",
]) {
  const value = optionalSetting(envMap, key);
  if (value) lines.push([key, value]);
}

const functionsEnvFile = path.join(rootDir, "functions", `.env.${projectId}`);
fs.writeFileSync(
  functionsEnvFile,
  `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  "utf8",
);

console.log(`Prepared Firebase Functions environment file: ${functionsEnvFile}`);
console.log(`Deploying Firebase target: ${deployOnly}`);

function run(command, args) {
  return spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

let deploy = run("firebase", ["deploy", "--only", deployOnly, "--project", projectId]);

if (deploy.error) {
  if (deploy.error.code === "ENOENT") {
    console.log("Firebase CLI global tidak ditemukan, mencoba via npx firebase-tools...");
    deploy = run("npx", [
      "firebase-tools",
      "deploy",
      "--only",
      deployOnly,
      "--project",
      projectId,
    ]);
  } else {
    console.error(deploy.error.message);
    process.exit(1);
  }
}

process.exit(deploy.status ?? 1);
