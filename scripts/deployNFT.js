/**
 * Deploy PropertyNFT to a specific network.
 * Usage: npx hardhat run scripts/deployNFT.js --network sepolia
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeploying PropertyNFT with: ${deployer.address}\n`);

  const PropertyNFT = await hre.ethers.getContractFactory("PropertyNFT");
  const nft = await PropertyNFT.deploy();
  await nft.deployed();

  console.log(`PropertyNFT deployed to: ${nft.address}`);
  return nft;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = main;
