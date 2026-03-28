/**
 * Deploy CCIPBridge contract to a specific network.
 * Usage: npx hardhat run scripts/deployBridge.js --network sepolia
 *
 * Requires env variables:
 *   BRT_TOKEN_ADDRESS, PROPERTY_NFT_ADDRESS,
 *   CCIP_ROUTER_ADDRESS, CHAIN_SELECTOR
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeploying CCIPBridge with: ${deployer.address}\n`);

  const brtAddress = process.env.BRT_TOKEN_ADDRESS;
  const nftAddress = process.env.PROPERTY_NFT_ADDRESS;
  const routerAddress = process.env.CCIP_ROUTER_ADDRESS;
  const chainSelector = process.env.CHAIN_SELECTOR;

  if (!brtAddress || !nftAddress || !routerAddress || !chainSelector) {
    throw new Error(
      "Set BRT_TOKEN_ADDRESS, PROPERTY_NFT_ADDRESS, CCIP_ROUTER_ADDRESS, CHAIN_SELECTOR"
    );
  }

  const CCIPBridge = await hre.ethers.getContractFactory("CCIPBridge");
  const bridge = await CCIPBridge.deploy(
    brtAddress,
    nftAddress,
    routerAddress,
    chainSelector
  );
  await bridge.deployed();

  console.log(`CCIPBridge deployed to: ${bridge.address}`);
  return bridge;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = main;
