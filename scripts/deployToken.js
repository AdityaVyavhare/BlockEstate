/**
 * Deploy BRTToken to a specific network.
 * Usage: npx hardhat run scripts/deployToken.js --network sepolia
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log(`\nDeploying BRTToken with: ${deployer.address}\n`);

  const BRTToken = await hre.ethers.getContractFactory("BRTToken");
  const brt = await BRTToken.deploy("Bridge Token", "BRT");
  await brt.deployed();

  console.log(`BRTToken deployed to: ${brt.address}`);
  return brt;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = main;
