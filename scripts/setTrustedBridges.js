/**
 * Wire CCIP peer bridges: each chain's CCIPBridge must trust the other chain's bridge address.
 *
 * Run after deploy (or if e2eCrossChainBuy.js shows "Peer bridge not set"):
 *   npx hardhat run scripts/setTrustedBridges.js
 *
 * If Sepolia already succeeded and only Amoy failed (e.g. gas / RPC):
 *   SKIP_SEPOLIA=1 npx hardhat run scripts/setTrustedBridges.js
 *
 * Requires: PRIVATE_KEY, SEPOLIA_RPC, AMOY_RPC, config.json with CCIPBridge on both networks.
 */
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TX_GAS_LIMIT = 500_000;

const NETWORKS = {
  sepolia: {
    rpc: process.env.SEPOLIA_RPC || "https://rpc.sepolia.org",
    chainSelector: process.env.SEPOLIA_CHAIN_SELECTOR || "16015286601757825753",
  },
  amoy: {
    rpc: process.env.AMOY_RPC || "https://rpc-amoy.polygon.technology",
    chainSelector: process.env.AMOY_CHAIN_SELECTOR || "16281711391670634445",
  },
};

const POLYGON_GAS_STATION_URL = "https://gasstation.polygon.technology/amoy";
const AMOY_FALLBACK_GAS = ethers.utils.parseUnits("30", "gwei");
/** Amoy enforces a high minimum tip (often 25+ gwei); Gas Station can still return lower. */
const AMOY_MIN_PRIORITY_WEI = ethers.utils.parseUnits("30", "gwei");
const AMOY_MIN_MAX_FEE_WEI = ethers.utils.parseUnits("70", "gwei");

/** ethers v5 has no BigNumber.max — use manual comparison. */
function bnMax(a, b) {
  return a.gt(b) ? a : b;
}

function clampAmoyGas(gas) {
  return {
    maxPriorityFeePerGas: bnMax(gas.maxPriorityFeePerGas, AMOY_MIN_PRIORITY_WEI),
    maxFeePerGas: bnMax(gas.maxFeePerGas, AMOY_MIN_MAX_FEE_WEI),
  };
}

async function fetchAmoyGas() {
  const https = require("https");
  return new Promise((resolve, reject) => {
    https
      .get(POLYGON_GAS_STATION_URL, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            const fast = data.fast || data.standard;
            const priorityFee = Math.ceil(fast.maxPriorityFee || 25);
            const maxFee = Math.ceil(fast.maxFee || 25);
            resolve({
              maxPriorityFeePerGas: ethers.utils.parseUnits(
                String(priorityFee),
                "gwei"
              ),
              maxFeePerGas: ethers.utils.parseUnits(String(maxFee), "gwei"),
            });
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function getAmoyTxOverrides() {
  const base = { gasLimit: TX_GAS_LIMIT };
  try {
    const raw = await fetchAmoyGas();
    const gas = clampAmoyGas(raw);
    console.log(
      `      Amoy gas: maxFee ${ethers.utils.formatUnits(gas.maxFeePerGas, "gwei")} gwei (tip ${ethers.utils.formatUnits(gas.maxPriorityFeePerGas, "gwei")} gwei)`
    );
    return { ...base, ...gas };
  } catch (e) {
    console.warn(
      `      Gas Station failed (${e.message}), using ${ethers.utils.formatUnits(
        AMOY_FALLBACK_GAS,
        "gwei"
      )} gwei fallback`
    );
    return {
      ...base,
      ...clampAmoyGas({
        maxFeePerGas: AMOY_FALLBACK_GAS,
        maxPriorityFeePerGas: AMOY_FALLBACK_GAS,
      }),
    };
  }
}

function loadArtifact(contractName) {
  const artifactPath = path.resolve(
    __dirname,
    `../artifacts/contracts/${contractName}.sol/${contractName}.json`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing ${artifactPath}. Run: npx hardhat compile`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

function formatErr(e) {
  const parts = [
    e.reason,
    e.message,
    e.error?.message,
    e.error?.body,
    e.body,
    e.data,
  ].filter(Boolean);
  return parts.join(" | ") || String(e);
}

async function main() {
  if (!PRIVATE_KEY) {
    throw new Error("Set PRIVATE_KEY in .env");
  }

  const skipSepolia =
    process.env.SKIP_SEPOLIA === "1" || process.env.ONLY_AMOY === "1";
  const skipAmoy =
    process.env.SKIP_AMOY === "1" || process.env.ONLY_SEPOLIA === "1";

  const configPath = path.join(__dirname, "../config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const sepoliaBridgeAddr = config.sepolia?.CCIPBridge;
  const amoyBridgeAddr = config.amoy?.CCIPBridge;
  if (!sepoliaBridgeAddr || !amoyBridgeAddr) {
    throw new Error("config.json must have sepolia.CCIPBridge and amoy.CCIPBridge");
  }

  const abi = loadArtifact("CCIPBridge").abi;
  const sepSel = ethers.BigNumber.from(NETWORKS.sepolia.chainSelector);
  const amoySel = ethers.BigNumber.from(NETWORKS.amoy.chainSelector);

  const sepoliaProvider = new ethers.providers.JsonRpcProvider(NETWORKS.sepolia.rpc);
  const amoyProvider = new ethers.providers.JsonRpcProvider(NETWORKS.amoy.rpc);
  const sepoliaWallet = new ethers.Wallet(PRIVATE_KEY, sepoliaProvider);
  const amoyWallet = new ethers.Wallet(PRIVATE_KEY, amoyProvider);

  console.log(`Deployer: ${sepoliaWallet.address}`);
  console.log(`Sepolia CCIPBridge: ${sepoliaBridgeAddr}`);
  console.log(`Amoy CCIPBridge:    ${amoyBridgeAddr}`);
  const polBal = await amoyProvider.getBalance(amoyWallet.address);
  console.log(
    `Amoy POL balance:   ${ethers.utils.formatEther(polBal)} (need gas for tx #2)\n`
  );
  if (polBal.lt(ethers.utils.parseEther("0.01"))) {
    console.warn(
      "  [!] Very low POL on Amoy — fund the deployer with testnet POL, then retry.\n"
    );
  }

  const sepoliaBridge = new ethers.Contract(sepoliaBridgeAddr, abi, sepoliaWallet);
  const amoyBridge = new ethers.Contract(amoyBridgeAddr, abi, amoyWallet);

  if (!skipSepolia) {
    console.log("[1/2] Sepolia → trust Amoy bridge...");
    try {
      let tx = await sepoliaBridge.setTrustedBridge(amoySel, amoyBridgeAddr, {
        gasLimit: TX_GAS_LIMIT,
      });
      await tx.wait();
      console.log(`      tx ${tx.hash}\n`);
    } catch (e) {
      console.error("Sepolia tx failed:", formatErr(e));
      throw e;
    }
  } else {
    console.log("[1/2] Skipped (SKIP_SEPOLIA=1)\n");
  }

  if (!skipAmoy) {
    console.log("[2/2] Amoy → trust Sepolia bridge...");
    const amoyOpts = await getAmoyTxOverrides();
    try {
      let tx = await amoyBridge.setTrustedBridge(
        sepSel,
        sepoliaBridgeAddr,
        amoyOpts
      );
      console.log(`      submitted ${tx.hash}`);
      await tx.wait();
      console.log(`      confirmed\n`);
    } catch (e) {
      console.error("\nAmoy tx failed:", formatErr(e));
      console.error(
        "\nTips: fund deployer with POL on Amoy; try another AMOY_RPC; retry only Amoy:\n" +
          "  SKIP_SEPOLIA=1 npx hardhat run scripts/setTrustedBridges.js\n"
      );
      throw e;
    }
  } else {
    console.log("[2/2] Skipped (SKIP_AMOY=1)\n");
  }

  const checkSep = await sepoliaBridge.trustedBridges(amoySel);
  const checkAmoy = await amoyBridge.trustedBridges(sepSel);
  console.log("Verify:");
  console.log(`  Sepolia.trustedBridges(Amoy): ${checkSep}`);
  console.log(`  Amoy.trustedBridges(Sepolia):   ${checkAmoy}`);
  if (checkSep.toLowerCase() !== amoyBridgeAddr.toLowerCase()) {
    throw new Error("Sepolia trust mismatch — run without SKIP_SEPOLIA if needed");
  }
  if (checkAmoy.toLowerCase() !== sepoliaBridgeAddr.toLowerCase()) {
    throw new Error("Amoy trust mismatch — run with SKIP_SEPOLIA=1 to retry only Amoy");
  }
  console.log("\nDone. Re-run: npx hardhat run scripts/e2eCrossChainBuy.js --network amoy");
}

main().catch((e) => {
  console.error(formatErr(e));
  process.exit(1);
});
