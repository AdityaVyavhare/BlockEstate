/**
 * Deploy Verification contract to a specific network.
 * Usage: npx hardhat run scripts/deployVerification.js --network sepolia
 *
 * Requires PropertyNFT address — set PROPERTY_NFT_ADDRESS env variable.
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeploying Verification with: ${deployer.address}\n`);

  const propertyNFTAddress = process.env.PROPERTY_NFT_ADDRESS;
  if (!propertyNFTAddress) {
    throw new Error("Set PROPERTY_NFT_ADDRESS env variable");
  }

  const Verification = await hre.ethers.getContractFactory("Verification");
  const verification = await Verification.deploy(propertyNFTAddress);
  await verification.deployed();

  console.log(`Verification deployed to: ${verification.address}`);
  return verification;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = main;
