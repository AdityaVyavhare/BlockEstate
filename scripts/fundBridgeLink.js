/**
 * Fund CCIPBridge with LINK so it can pay return CCIP messages for cross-chain buys.
 *
 * Usage:
 *   npx hardhat run scripts/fundBridgeLink.js --network sepolia
 *   npx hardhat run scripts/fundBridgeLink.js --network amoy
 *
 * Requires:
 *   - LINK token balance in your wallet on that network
 *   - config.json with CCIPBridge address for the network
 */
const hre = require("hardhat");
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const configPath = path.join(__dirname, "../config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const LINK_ADDRESSES = {
  sepolia: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  amoy: "0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

async function main() {
  const networkName = hre.network.name;
  const netConfig = config[networkName];
  if (!netConfig?.CCIPBridge) {
    throw new Error(`No CCIPBridge address for ${networkName} in config.json`);
  }

  const linkAddr = LINK_ADDRESSES[networkName] || process.env[`${networkName.toUpperCase()}_LINK`];
  if (!linkAddr) {
    throw new Error(`No LINK token address for ${networkName}`);
  }

  const [signer] = await hre.ethers.getSigners();
  const bridgeAddr = netConfig.CCIPBridge;
  const amountRaw = process.env.FUND_AMOUNT || process.env.FUND_BRIDGE_LINK_AMOUNT || "0.5";
  const amount =
    typeof amountRaw === "string" && amountRaw.startsWith("0x")
      ? ethers.BigNumber.from(amountRaw)
      : ethers.utils.parseEther(String(amountRaw).trim());

  const link = new ethers.Contract(linkAddr, ERC20_ABI, signer);
  const balance = await link.balanceOf(signer.address);
  if (balance.lt(amount)) {
    console.error(
      `Insufficient LINK: have ${ethers.utils.formatEther(balance)}, need ${ethers.utils.formatEther(amount)}. Get testnet LINK from a faucet.`,
    );
    process.exit(1);
  }

  const allowance = await link.allowance(signer.address, bridgeAddr);
  if (allowance.lt(amount)) {
    console.log("Approving LINK...");
    const tx = await link.approve(bridgeAddr, ethers.constants.MaxUint256);
    await tx.wait();
    console.log("Approved.");
  }

  const bridge = await hre.ethers.getContractAt("CCIPBridge", bridgeAddr);
  console.log(`Funding ${bridgeAddr} with ${ethers.utils.formatEther(amount)} LINK...`);
  const tx = await bridge.fundReturnLink(amount);
  await tx.wait();
  console.log("Done. The bridge can now pay return CCIP messages for cross-chain buys.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
