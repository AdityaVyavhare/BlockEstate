/**
 * Post-deployment script: updates frontend with deployed addresses + ABIs.
 *
 * Usage (called automatically by deployAllChains.js, or manually):
 *   node scripts/updateConfigAndABI.js
 *
 * What it does:
 *   1. Reads compiled artifacts for all contracts
 *   2. Extracts ABI and writes to frontend/src/abi/
 *   3. Merges new addresses into config.json (per network)
 */

const fs = require("fs");
const path = require("path");

// ── Paths ──────────────────────────────────────────────────
const FRONTEND_ABI_DIR = path.resolve(__dirname, "../frontend/src/abi");
const CONFIG_FILE = path.resolve(__dirname, "../config.json");
const ARTIFACTS_DIR = path.resolve(__dirname, "../artifacts/contracts");
const DEPLOYMENTS_DIR = path.resolve(__dirname, "../deployments");
const DEFAULT_DEPLOY_OUTPUT = path.join(DEPLOYMENTS_DIR, "deployOutput.json");

// Contracts we care about
const CONTRACTS = [
  "BRTToken",
  "PropertyNFT",
  "Verification",
  "Marketplace",
  "CCIPBridge",
];

// ── Helpers ────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ── Export ABIs ────────────────────────────────────────────
function exportAbis() {
  ensureDir(FRONTEND_ABI_DIR);

  for (const name of CONTRACTS) {
    const artifactPath = path.join(
      ARTIFACTS_DIR,
      `${name}.sol`,
      `${name}.json`
    );
    if (!fs.existsSync(artifactPath)) {
      console.warn(`  ⚠  Artifact not found: ${artifactPath} (compile first)`);
      continue;
    }
    const artifact = readJSON(artifactPath);
    const abiFile = path.join(FRONTEND_ABI_DIR, `${name}.json`);
    writeJSON(abiFile, artifact.abi);
    console.log(`  ✔ ABI  ${name} → frontend/src/abi/${name}.json`);
  }
}

// ── Save addresses ─────────────────────────────────────────
function saveAddresses(networkName, addressMap) {
  const existing = readJSON(CONFIG_FILE);
  existing[networkName] = {
    ...(existing[networkName] || {}),
    ...addressMap,
  };
  writeJSON(CONFIG_FILE, existing);
  console.log(`  ✔ Addresses saved for "${networkName}" → config.json`);
}

function normalizeDeploymentAddresses(addresses) {
  // Support both naming styles:
  // - CCIPBridge (current codebase)
  // - Bridge (required by the prompt)
  const out = { ...addresses };
  if (!out.Bridge && out.CCIPBridge) out.Bridge = out.CCIPBridge;
  if (!out.CCIPBridge && out.Bridge) out.CCIPBridge = out.Bridge;
  return out;
}

function updateConfigFromDeploymentOutput(deploymentOutput) {
  if (!deploymentOutput || typeof deploymentOutput !== "object") {
    throw new Error("Invalid deployment output JSON");
  }

  const existing = readJSON(CONFIG_FILE);
  for (const [networkName, addresses] of Object.entries(deploymentOutput)) {
    existing[networkName] = normalizeDeploymentAddresses(addresses);
  }
  writeJSON(CONFIG_FILE, existing);
  console.log(`  ✔ config.json updated from deployment output`);
}

// ── CLI entry ──────────────────────────────────────────────
async function main() {
  console.log("\n📦 Updating frontend config and ABIs...\n");
  exportAbis();
  const inputPath =
    process.env.DEPLOY_OUTPUT ||
    (process.argv.includes("--input")
      ? process.argv[process.argv.indexOf("--input") + 1]
      : DEFAULT_DEPLOY_OUTPUT);

  if (!fs.existsSync(inputPath)) {
    console.warn(
      `  ⚠  Deployment output not found (${inputPath}). Only ABIs were exported.`
    );
    return;
  }

  const deploymentOutput = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  updateConfigFromDeploymentOutput(deploymentOutput);
}

// Allow both `require()` and direct execution
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  exportAbis,
  saveAddresses,
  updateConfigFromDeploymentOutput,
  normalizeDeploymentAddresses,
};
