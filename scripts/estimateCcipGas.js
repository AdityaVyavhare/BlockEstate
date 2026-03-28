/**
 * Helper: suggests destination gas limit for CCIP bridge.
 * Run: bridge.setDestinationGasLimit(suggested) as owner if you want to tune.
 *
 * Typical ranges:
 *   - MINT_WRAPPED: ~150k-200k gas
 *   - RELEASE_ORIGINAL: ~80k-100k gas
 *
 * Default 200k in the contract is a safe minimum. Increase only if execution reverts.
 *
 * Usage: npx hardhat run scripts/estimateCcipGas.js
 */

console.log(`
  CCIP Bridge Destination Gas
  ---------------------------
  Default: 200,000 (configured in CCIPBridge.destinationGasLimit)
  Tune via: bridge.setDestinationGasLimit(uint256) as owner

  If _ccipReceive reverts with "out of gas", increase the limit.
  Lower limit = lower CCIP fee. Target the minimum that works.
`);
