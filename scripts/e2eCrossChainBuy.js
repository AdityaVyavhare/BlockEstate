/**
 * Post-deploy sanity checks for CCIP cross-chain buy (read-only).
 * Does not send a transaction unless RUN_CCIP_E2E_TX=1 (see below).
 *
 * Usage:
 *   npx hardhat run scripts/e2eCrossChainBuy.js --network sepolia
 *   npx hardhat run scripts/e2eCrossChainBuy.js --network amoy
 *
 * Env:
 *   RUN_CCIP_E2E_TX=1 — optional; requires extra setup (listed NFT, buyer LINK/BRT, etc.)
 */
const hre = require("hardhat");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const configPath = path.join(__dirname, "../config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

function loadCcipArtifactAbi() {
  const artifactPath = path.join(
    __dirname,
    "../artifacts/contracts/CCIPBridge.sol/CCIPBridge.json"
  );
  if (!fs.existsSync(artifactPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;
}

const SEPOLIA_SELECTOR = "16015286601757825753";
const AMOY_SELECTOR = "16281711391670634445";

async function tryRead(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function main() {
  const net = hre.network.name;
  const netConfig = config[net];
  if (!netConfig?.CCIPBridge) {
    throw new Error(`No CCIPBridge in config.json for ${net}`);
  }

  const provider = hre.ethers.provider;
  const abi = loadCcipArtifactAbi();
  if (!abi) {
    throw new Error("Compile first: npx hardhat compile (need CCIPBridge artifact for ABI)");
  }
  const bridge = new ethers.Contract(netConfig.CCIPBridge, abi, provider);

  const peerSel = net === "sepolia" ? AMOY_SELECTOR : SEPOLIA_SELECTOR;
  const peerTrusted = await bridge.trustedBridges(ethers.BigNumber.from(peerSel));

  console.log(`\n[CCIP e2e check] network=${net}`);
  console.log(`  CCIPBridge: ${netConfig.CCIPBridge}`);
  console.log(`  trustedBridges(${peerSel}): ${peerTrusted}`);
  const g1 = await tryRead(() => bridge.bridgeOutGasLimit());
  const g2 = await tryRead(() => bridge.listingChainReceiveGasLimit());
  const g3 = await tryRead(() => bridge.returnDestinationGasLimit());
  if (g1 != null && g2 != null && g3 != null) {
    console.log(`  bridgeOutGasLimit:           ${g1.toString()}`);
    console.log(`  listingChainReceiveGasLimit: ${g2.toString()}`);
    console.log(`  returnDestinationGasLimit:   ${g3.toString()}`);
  } else {
    console.log(
      `  (Gas getters unavailable on-chain — older CCIPBridge; redeploy for split gas limits.)`,
    );
  }

  if (peerTrusted === ethers.constants.AddressZero) {
    console.warn(
      "\n  ⚠ Peer bridge not set — run deployAllChains or setTrustedBridge on both chains.\n"
    );
  } else {
    console.log("\n  ✔ Peer bridge is configured.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
