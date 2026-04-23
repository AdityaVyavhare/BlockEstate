/**
 * Deploy ALL Real Estate NFT Marketplace contracts to Sepolia AND Amoy.
 *
 * Usage:
 *   npx hardhat run scripts/deployAllChains.js
 */
const hre = require("hardhat");
const { ethers } = require("ethers");
const {
  exportAbis,
  saveAddresses,
  updateConfigFromDeploymentOutput,
} = require("./updateConfigAndABI");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error(
    "Set PRIVATE_KEY in .env (your MetaMask account private key)",
  );
}

// LINK token addresses for CCIP fee payment (testnet)
const LINK_ADDRESSES = {
  sepolia:
    process.env.SEPOLIA_LINK || "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  amoy: process.env.AMOY_LINK || "0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904",
};

const NETWORKS = {
  sepolia: {
    name: "sepolia",
    rpc: process.env.SEPOLIA_RPC || "https://rpc.sepolia.org",
    chainId: 11155111,
    nativeToken: "ETH",
    ccipRouter:
      process.env.SEPOLIA_CCIP_ROUTER ||
      "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
    chainSelector: process.env.SEPOLIA_CHAIN_SELECTOR || "16015286601757825753",
    linkToken: LINK_ADDRESSES.sepolia,
  },
  amoy: {
    name: "amoy",
    rpc: process.env.AMOY_RPC || "https://rpc-amoy.polygon.technology",
    chainId: 80002,
    nativeToken: "POL",
    ccipRouter:
      process.env.AMOY_CCIP_ROUTER ||
      "0x9C32fCB86BF0f4a1A8921a9Fe46de3198bb884B2",
    chainSelector: process.env.AMOY_CHAIN_SELECTOR || "16281711391670634445",
    linkToken: LINK_ADDRESSES.amoy,
  },
};

// Explicit gas limit to avoid estimation failures (circular Promise reject)
// CCIPBridge bytecode is large (~11.5k bytes); 2.5M gas can OOG on Amoy. Use 5M (~0.15 POL @ 30 gwei).
const DEPLOY_GAS_LIMIT = 5_000_000;
const TX_GAS_LIMIT = 500_000;

/** Demo users registered via admin (Verification.addUser) — each receives 1M BRT (initialUserMint). */
const DEMO_USERS = [
  "0x9ae2F46cb87384c547160949806E4BC56F82d2eb",
  "0x4b4680ed75c5B7e1df94325d514Ea7f2458f0c36",
];

const ERC20_MIN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const CCIP_BRIDGE_FUND_ABI = [
  "function fundReturnLink(uint256 amount) external",
];

// Polygon Gas Station API
const POLYGON_GAS_STATION_URL = "https://gasstation.polygon.technology/amoy";
const AMOY_FALLBACK_GAS = ethers.utils.parseUnits("30", "gwei");
const AMOY_MIN_PRIORITY_WEI = ethers.utils.parseUnits("30", "gwei");
const AMOY_MIN_MAX_FEE_WEI = ethers.utils.parseUnits("70", "gwei");

/** ethers v5 has no BigNumber.max — use manual comparison. */
function bnMax(a, b) {
  return a.gt(b) ? a : b;
}

function clampAmoyGas(gas) {
  return {
    maxPriorityFeePerGas: bnMax(
      gas.maxPriorityFeePerGas,
      AMOY_MIN_PRIORITY_WEI,
    ),
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
          const data = JSON.parse(body);
          const fast = data.fast || data.standard;
          const priorityFee = Math.ceil(fast.maxPriorityFee || 25);
          const maxFee = Math.ceil(fast.maxFee || 25);
          resolve({
            maxPriorityFeePerGas: ethers.utils.parseUnits(
              String(priorityFee),
              "gwei",
            ),
            maxFeePerGas: ethers.utils.parseUnits(String(maxFee), "gwei"),
          });
        });
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function fundBridgeLinkIfPossible(
  wallet,
  bridgeAddress,
  linkTokenAddress,
  gasOverrides,
  networkName,
) {
  const amountStr = process.env.FUND_BRIDGE_LINK_AMOUNT || "0.5";
  const amount = ethers.utils.parseEther(amountStr);
  const link = new ethers.Contract(linkTokenAddress, ERC20_MIN_ABI, wallet);
  const bal = await link.balanceOf(wallet.address);
  if (bal.lt(amount)) {
    console.warn(
      `  [!] Skipping auto LINK fund on ${networkName}: need ${ethers.utils.formatEther(
        amount,
      )} LINK, have ${ethers.utils.formatEther(
        bal,
      )}. Fund the deployer wallet with testnet LINK, then run:\n` +
        `      npx hardhat run scripts/fundBridgeLink.js --network ${networkName}`,
    );
    return;
  }
  const allowance = await link.allowance(wallet.address, bridgeAddress);
  if (allowance.lt(amount)) {
    console.log(`  Approving LINK for CCIPBridge on ${networkName}...`);
    const txA = await link.approve(
      bridgeAddress,
      ethers.constants.MaxUint256,
      gasOverrides,
    );
    await txA.wait();
  }
  const bridge = new ethers.Contract(
    bridgeAddress,
    CCIP_BRIDGE_FUND_ABI,
    wallet,
  );
  console.log(
    `  Funding CCIPBridge with ${ethers.utils.formatEther(
      amount,
    )} LINK on ${networkName}...`,
  );
  const txF = await bridge.fundReturnLink(amount, gasOverrides);
  await txF.wait();
  console.log(`         -> Bridge LINK balance ready for return CCIP messages`);
}

async function getGasOverrides(networkName) {
  const base = { gasLimit: DEPLOY_GAS_LIMIT };
  if (networkName !== "amoy") return base;
  try {
    const gas = clampAmoyGas(await fetchAmoyGas());
    console.log(`  Gas (from Polygon Gas Station, clamped for Amoy min tip):`);
    console.log(
      `    maxFeePerGas:         ${ethers.utils.formatUnits(
        gas.maxFeePerGas,
        "gwei",
      )} gwei`,
    );
    console.log(
      `    maxPriorityFeePerGas: ${ethers.utils.formatUnits(
        gas.maxPriorityFeePerGas,
        "gwei",
      )} gwei\n`,
    );
    return { ...base, ...gas };
  } catch (e) {
    console.log(
      `  Gas Station API failed (${e.message}), using 30 gwei fallback\n`,
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

// Read compiled artifact (ABI + bytecode)
function loadArtifact(contractName) {
  const artifactPath = path.resolve(
    __dirname,
    `../artifacts/contracts/${contractName}.sol/${contractName}.json`,
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Artifact not found: ${artifactPath}. Run "npx hardhat compile" first.`,
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

// Deploy a single contract (uses explicit gasLimit to avoid estimation failures)
async function deployContract(
  wallet,
  contractName,
  args = [],
  gasOverrides = {},
) {
  const overrides = { gasLimit: DEPLOY_GAS_LIMIT, ...gasOverrides };
  const artifact = loadArtifact(contractName);
  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet,
  );
  try {
    const contract = await factory.deploy(...args, overrides);
    await contract.deployTransaction.wait();
    return contract;
  } catch (err) {
    const msg = err.reason || err.shortMessage || err.message || String(err);
    const data = err.error?.data || err.data;
    const extra = data ? ` data=${String(data).slice(0, 200)}` : "";
    const receiptHint =
      err.receipt?.status === 0
        ? " (tx mined but reverted — check constructor args / router address)"
        : "";
    throw new Error(
      `${contractName} deploy failed: ${msg}${receiptHint}${extra}`,
    );
  }
}

// Deploy all contracts + wire permissions on one network
async function deployToNetwork(networkConfig) {
  const { name, rpc, chainId, nativeToken, ccipRouter, chainSelector } =
    networkConfig;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Deploying to ${name.toUpperCase()} (chainId: ${chainId})`);
  console.log(`${"=".repeat(60)}\n`);

  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const balance = await wallet.getBalance();

  console.log(`  Deployer:  ${wallet.address}`);
  console.log(
    `  Balance:   ${ethers.utils.formatEther(balance)} ${nativeToken}\n`,
  );

  if (balance.eq(0)) {
    throw new Error(
      `No balance on ${name}. Fund ${wallet.address} with ${nativeToken} first.`,
    );
  }

  const gasOverrides = await getGasOverrides(name);

  // Pre-flight: ensure enough for intrinsic cost (gasLimit * maxFee)
  const gasLimit = gasOverrides.gasLimit || DEPLOY_GAS_LIMIT;
  const maxFee = gasOverrides.maxFeePerGas || (await provider.getGasPrice());
  const minRequired = ethers.BigNumber.from(gasLimit).mul(maxFee);
  if (balance.lt(minRequired)) {
    throw new Error(
      `Insufficient funds on ${name}. Need ~${ethers.utils.formatEther(
        minRequired,
      )} ${nativeToken} for deploy, have ${ethers.utils.formatEther(
        balance,
      )}. Fund ${wallet.address}.`,
    );
  }

  // 1. BRTToken
  console.log("  [1/5] Deploying BRTToken...");
  const brt = await deployContract(
    wallet,
    "BRTToken",
    ["Bridge Token", "BRT"],
    gasOverrides,
  );
  console.log(`         -> ${brt.address}`);

  // 2. PropertyNFT
  console.log("  [2/5] Deploying PropertyNFT...");
  const nft = await deployContract(wallet, "PropertyNFT", [], gasOverrides);
  console.log(`         -> ${nft.address}`);

  // 3. Verification
  console.log("  [3/5] Deploying Verification...");
  const verifier = await deployContract(
    wallet,
    "Verification",
    [nft.address, brt.address],
    gasOverrides,
  );
  console.log(`         -> ${verifier.address}`);

  // Allow Verification contract to mint initial BRT on addUser/addValidator
  let tx = await brt.setBridge(verifier.address, true, gasOverrides);
  await tx.wait();
  console.log(
    "    -> BRTToken: authorized verification for initial role mints",
  );

  // Add deployer as first validator
  tx = await verifier.addValidator(wallet.address, gasOverrides);
  await tx.wait();
  console.log(`         -> Added deployer as validator`);

  // Add deployer as user (can buy + sell on this marketplace)
  tx = await verifier.addUser(wallet.address, gasOverrides);
  await tx.wait();
  console.log(`         -> Added deployer as user`);

  for (const raw of DEMO_USERS) {
    const addr = ethers.utils.getAddress(raw.trim());
    try {
      tx = await verifier.addUser(addr, gasOverrides);
      await tx.wait();
      console.log(`         -> Added demo user ${addr} (1M BRT)`);
    } catch (e) {
      const msg = e?.reason || e?.message || String(e);
      if (msg.includes("Already a user")) {
        console.log(
          `         -> Demo user ${addr} already registered — skipping`,
        );
      } else {
        throw e;
      }
    }
  }

  // 4. Marketplace
  console.log("  [4/5] Deploying Marketplace...");
  const market = await deployContract(
    wallet,
    "Marketplace",
    [brt.address, nft.address, verifier.address],
    gasOverrides,
  );
  console.log(`         -> ${market.address}`);

  // 5. CCIPBridge
  console.log("  [5/5] Deploying CCIPBridge...");
  const linkToken = networkConfig.linkToken;
  // uint64 chain selectors exceed JS Number.MAX_SAFE_INTEGER — must use BigNumber
  const chainSelectorBn = ethers.BigNumber.from(chainSelector);
  const bridge = await deployContract(
    wallet,
    "CCIPBridge",
    [
      brt.address,
      nft.address,
      market.address,
      verifier.address,
      ccipRouter,
      chainSelectorBn,
      linkToken,
    ],
    gasOverrides,
  );
  console.log(`         -> ${bridge.address}`);

  // Wire permissions
  console.log("\n  Wiring permissions...");

  tx = await nft.setVerificationContract(verifier.address, gasOverrides);
  await tx.wait();
  console.log("    -> PropertyNFT: verification contract set");

  tx = await nft.setMarketplaceContract(market.address, gasOverrides);
  await tx.wait();
  console.log("    -> PropertyNFT: marketplace contract set");

  tx = await nft.setBridgeContract(bridge.address, gasOverrides);
  await tx.wait();
  console.log("    -> PropertyNFT: bridge contract set");

  tx = await brt.setBridge(bridge.address, true, gasOverrides);
  await tx.wait();
  console.log("    -> BRTToken: authorized bridge for mint/burn");

  tx = await market.setBridgeContract(bridge.address, gasOverrides);
  await tx.wait();
  console.log("    -> Marketplace: authorized bridge contract");

  await fundBridgeLinkIfPossible(
    wallet,
    bridge.address,
    linkToken,
    gasOverrides,
    name,
  );

  // Save addresses for this network
  saveAddresses(name, {
    BRTToken: brt.address,
    PropertyNFT: nft.address,
    Verification: verifier.address,
    Marketplace: market.address,
    CCIPBridge: bridge.address,
  });

  console.log(`\n  ${name.toUpperCase()} deployment complete!\n`);

  return {
    BRTToken: brt.address,
    PropertyNFT: nft.address,
    Verification: verifier.address,
    Marketplace: market.address,
    CCIPBridge: bridge.address,
  };
}

async function main() {
  // Compile first
  console.log("\nCompiling contracts...\n");
  await hre.run("compile");

  const wallet = new ethers.Wallet(PRIVATE_KEY);
  console.log(`\nDeployer (MetaMask account): ${wallet.address}`);

  // Export ABIs to frontend
  exportAbis();

  // Deploy to both networks (Amoy first, then Sepolia)
  const amoyAddresses = await deployToNetwork(NETWORKS.amoy);
  const sepoliaAddresses = await deployToNetwork(NETWORKS.sepolia);

  // Persist a deployment output snapshot for `updateConfigAndABI.js`.
  const DEPLOYMENTS_DIR = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const deployOutputPath = path.join(DEPLOYMENTS_DIR, "deployOutput.json");
  const deploymentOutput = {
    sepolia: sepoliaAddresses,
    amoy: amoyAddresses,
  };
  fs.writeFileSync(
    deployOutputPath,
    JSON.stringify(deploymentOutput, null, 2) + "\n",
    "utf8",
  );

  // Wire cross-chain trusted bridges
  console.log(`\n${"=".repeat(60)}`);
  console.log("  WIRING CROSS-CHAIN TRUSTED BRIDGES");
  console.log(`${"=".repeat(60)}\n`);

  // On Sepolia bridge, trust Amoy bridge
  const sepoliaProvider = new ethers.providers.JsonRpcProvider(
    NETWORKS.sepolia.rpc,
  );
  const sepoliaWallet = new ethers.Wallet(PRIVATE_KEY, sepoliaProvider);
  const sepoliaBridgeArtifact = loadArtifact("CCIPBridge");
  const sepoliaBridge = new ethers.Contract(
    sepoliaAddresses.CCIPBridge,
    sepoliaBridgeArtifact.abi,
    sepoliaWallet,
  );

  let txCross = await sepoliaBridge.setTrustedBridge(
    NETWORKS.amoy.chainSelector,
    amoyAddresses.CCIPBridge,
    { gasLimit: TX_GAS_LIMIT },
  );
  await txCross.wait();
  console.log(
    `  Sepolia bridge trusts Amoy bridge: ${amoyAddresses.CCIPBridge}`,
  );

  // On Amoy bridge, trust Sepolia bridge
  const amoyProvider = new ethers.providers.JsonRpcProvider(NETWORKS.amoy.rpc);
  const amoyWallet = new ethers.Wallet(PRIVATE_KEY, amoyProvider);
  const amoyGas = await getGasOverrides("amoy");
  const amoyBridge = new ethers.Contract(
    amoyAddresses.CCIPBridge,
    sepoliaBridgeArtifact.abi,
    amoyWallet,
  );

  txCross = await amoyBridge.setTrustedBridge(
    NETWORKS.sepolia.chainSelector,
    sepoliaAddresses.CCIPBridge,
    amoyGas,
  );
  await txCross.wait();
  console.log(
    `  Amoy bridge trusts Sepolia bridge: ${sepoliaAddresses.CCIPBridge}`,
  );

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("  DEPLOYMENT COMPLETE - ALL CONTRACTS LIVE");
  console.log(`${"=".repeat(60)}\n`);

  console.log("  SEPOLIA:");
  for (const [name, addr] of Object.entries(sepoliaAddresses)) {
    console.log(`    ${name.padEnd(20)} ${addr}`);
  }

  console.log("\n  AMOY:");
  for (const [name, addr] of Object.entries(amoyAddresses)) {
    console.log(`    ${name.padEnd(20)} ${addr}`);
  }

  console.log(`\n  config.json and frontend ABIs have been auto-updated.\n`);

  // Ensure the required `Bridge` alias exists in config.json.
  exportAbis();
  updateConfigFromDeploymentOutput(deploymentOutput);
}

function formatDeployError(err) {
  const msg = err.reason || err.message || String(err);
  const data = err.data ? `\n  data: ${err.data}` : "";
  const shortMessage = err.shortMessage || "";
  return `Deployment failed: ${msg}${
    shortMessage ? ` (${shortMessage})` : ""
  }${data}`;
}

main().catch((error) => {
  console.error(formatDeployError(error));
  process.exitCode = 1;
});
