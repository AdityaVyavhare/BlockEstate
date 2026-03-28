/**
 * Deploy Marketplace contract to a specific network.
 * Usage: npx hardhat run scripts/deployMarketplace.js --network sepolia
 *
 * Requires BRT_TOKEN_ADDRESS and PROPERTY_NFT_ADDRESS env variables.
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeploying Marketplace with: ${deployer.address}\n`);

  const brtAddress = process.env.BRT_TOKEN_ADDRESS;
  const nftAddress = process.env.PROPERTY_NFT_ADDRESS;

  if (!brtAddress || !nftAddress) {
    throw new Error("Set BRT_TOKEN_ADDRESS and PROPERTY_NFT_ADDRESS env variables");
  }

  const Marketplace = await hre.ethers.getContractFactory("Marketplace");
  const marketplace = await Marketplace.deploy(brtAddress, nftAddress);
  await marketplace.deployed();

  console.log(`Marketplace deployed to: ${marketplace.address}`);
  return marketplace;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = main;
