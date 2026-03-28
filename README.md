# RealEstateNFT — Cross-Chain Real Estate Marketplace

A decentralized cross-chain real estate NFT marketplace using Chainlink CCIP for direct NFT transfer, BRT (ERC20) token payments, and majority-based validator verification. Works across:

- Ethereum Sepolia
- Polygon Amoy

## What’s included

- Solidity contracts (ERC20, ERC721, majority-voting validator registry, BRT marketplace, strict CCIP bridge)
- Hardhat test suite (Mocha/Chai)
- Multi-chain deployment scripts (Sepolia + Amoy)
- Auto ABI + `config.json` update script
- Next.js + TypeScript + Redux frontend (multi-chain dashboard, validator UI, cross-chain buy UI)

## Prerequisites

- Node.js 18+ (recommended)
- npm
- MetaMask with Sepolia + Amoy added
- (For real IPFS uploads) Pinata keys
- (For deployments) a funded deployer wallet

## Setup

### 1) Contracts + tests (Hardhat)

```bash
cd e:\BlockChain\RealEstateNFT
npm install
```

Create a `.env` file (based on `.env.example`) in the repo root:

- `PRIVATE_KEY`
- `SEPOLIA_RPC`, `AMOY_RPC`
- `SEPOLIA_CCIP_ROUTER`, `AMOY_CCIP_ROUTER`
- `SEPOLIA_CHAIN_SELECTOR`, `AMOY_CHAIN_SELECTOR`
- `NEXT_PUBLIC_PINATA_API_KEY`, `NEXT_PUBLIC_PINATA_SECRET_KEY`, `NEXT_PUBLIC_PINATA_GATEWAY`

### 2) Frontend (Next.js)

```bash
cd e:\BlockChain\RealEstateNFT\frontend
npm install
```

Frontend expects the same Pinata env vars to upload documents/metadata.

## Testing

From the repo root:

```bash
npm test
```

## Deployment (Sepolia + Amoy)

From the repo root:

```bash
npm run deploy
```

This runs:

- `deployAllChains.js`
- Deploys `BRTToken`, `PropertyNFT`, `Verification`, `Marketplace`, `CCIPBridge` on both chains
- Wires `PropertyNFT` permissions (verification marketplace/bridge)
- Wires cross-chain trust (each `CCIPBridge` trusts the other chain’s bridge)
- Writes `config.json` and exports ABIs to `frontend/src/abi/`

## ABI + config auto-update

The script `scripts/updateConfigAndABI.js`:

- Reads deployment output (`deployments/deployOutput.json`)
- Updates `config.json` (including the required `Bridge` alias)
- Exports ABIs into `frontend/src/abi/`

You can run it manually after a deployment:

```bash
node scripts/updateConfigAndABI.js
```

## Running the frontend

```bash
cd e:\BlockChain\RealEstateNFT\frontend
npm run dev
```

Then open the displayed local URL.

## Notes / Security highlights

- Marketplace purchases use `BRT` (`transferFrom` + allowance required), not ETH
- CCIP replay protection via `messageId` (`processedMessages`)
- CCIP sender validation via trusted bridge mapping
- Majority voting verification:
  - validators register
  - each validator votes once per property
  - verified outcome is based on majority threshold

