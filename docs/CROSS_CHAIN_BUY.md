# Cross-chain marketplace buy (CCIP)

## Transaction states (app tracking)

Cross-chain buys use this sequence (see **Activity** for timeline + hashes):

| State | Meaning |
| ----- | ------- |
| **Initiated** | Buyer transaction submitted on the buyer (home) chain. |
| **Pending** | Confirmed on buyer chain; CCIP is delivering the purchase request to the listing chain. |
| **Executed** | Listing chain processed the message: listing closed, NFT locked in `CCIPBridge` (see listing-chain tx when indexed). |
| **Completed** | Return CCIP minted the **wrapped** NFT to the buyer on the home chain (destination tx = `CrossChainBuyFulfilled`). |
| **Failed** | Reserved for future explicit failure handling. |

**Note:** The listing cannot be closed on-chain on the listing chain *before* the CCIP message arrives (buyer only signs on the buyer chain). The app **hides the listing card for this browser** while your purchase is pending; other users still see it until the listing chain executes.

## Flow

1. **Buyer** stays on their chain (e.g. Polygon Amoy) and calls `CCIPBridge.crossChainBuyFromListing` with the **listing chain’s** CCIP selector, `tokenId`, and exact listing price (wei).
2. The bridge **pulls BRT** (escrow) and **LINK** (outbound CCIP fee) from the buyer.
3. A **CCIP message** is sent to the **listing chain** (e.g. Ethereum Sepolia).
4. On the listing chain, the peer bridge calls `Marketplace.finalizeRemotePurchaseToBridge`: the NFT moves **seller → bridge** (locked) and the listing is closed.
5. The listing-chain bridge sends a **return CCIP message** to the buyer chain.
6. On the buyer chain, `_handleRemotePurchaseFulfill` **mints a wrapped NFT** to the buyer and pays **seller + platform fee** in **local BRT** from escrow.

## Operator requirement: LINK on the listing-chain bridge

**If cross-chain buys never complete** (listing stays visible, wrapped NFT never appears, Activity stuck on "In Transit"): the most common cause is the **listing-chain bridge has no LINK** to pay the return CCIP message. The app now **checks before purchase** and shows an error if the bridge has &lt; 0.05 LINK.

The **return** `ccipSend` is paid from **LINK held by `CCIPBridge` on the listing chain** (not from the buyer). If balance is too low, the fulfill step reverts with `Insufficient LINK for CCIP return`.

Fund each listing-side bridge as needed:

```text
# On Sepolia (example): approve + fundReturnLink on the Sepolia CCIPBridge
# Use the Chainlink CCIP docs for testnet LINK faucets.
```

1. Obtain testnet **LINK** on the listing chain ([Sepolia faucet](https://faucets.chain.link/sepolia), [Polygon faucet](https://faucets.chain.link/polygon-amoy)).
2. Run: `npx hardhat run scripts/fundBridgeLink.js --network sepolia` (or `amoy`).
3. Or manually: `LINK.approve(ccipBridgeAddress, amount)` then `CCIPBridge.fundReturnLink(amount)`.

Use `FUND_AMOUNT=0.5` (default 0.5 LINK) to fund more: `FUND_AMOUNT=1 npx hardhat run scripts/fundBridgeLink.js --network sepolia`.

Repeat for **both** networks if you want purchases to work in **both directions** (Amoy-listed assets bought from Sepolia, and Sepolia-listed assets bought from Amoy).

## User requirements

- Registered as a **user** on the **buyer chain** (`Verification.isUser`).
- Enough **BRT** on the buyer chain for the full list price.
- Enough **LINK** on the buyer chain for `getCrossChainBuyLinkFee(...)` (keep a small buffer — the on-chain fee can be slightly higher than the quote).
- The app approves **LINK with unlimited allowance** to `CCIPBridge` so a higher on-chain fee does not hit `ERC20: insufficient allowance` (common when approving only the exact quoted fee).
- Seller receives **BRT on the buyer chain** (same EOA address).

## Why does the listing still show on the listing chain after “success”?

Your wallet **success** is usually **only the transaction on your chain** that **sends** the CCIP message. The **marketplace listing** (`listing.active`) is turned off on the **listing chain** only when the **peer bridge** runs `finalizeRemotePurchaseToBridge` — after Chainlink **delivers** that message (often **minutes**). Until then, the UI still shows the card; **refresh** or wait. If it never disappears, the destination leg failed (check listing-chain bridge **LINK** balance, trusted peers, and CCIP explorer).

The **original NFT** remains on the **listing chain** inside **`CCIPBridge`** after a successful full flow; you receive a **wrapped** NFT on **your** chain. That is by design.

## Contract events (debugging / explorers)

After upgrading contracts, redeploy **Marketplace** and **CCIPBridge** and update `config.json` + frontend ABIs.

| Event | Contract | When |
| ----- | -------- | ---- |
| `PropertyListed` / `ListingCreated` | Marketplace | On-chain listing stored with `active = true` |
| `CCIPMessageSent` | CCIPBridge | After each successful `ccipSend` (initial + return leg) |
| `CCIPMessageReceived` | CCIPBridge | After trust checks in `_ccipReceive` |
| `CrossChainBuyInitiated` / `CrossChainBuyFulfilled` | CCIPBridge | Cross-chain buy legs |
| `WrappedMintedOnDestination` | CCIPBridge | Wrapped NFT mint (use as “NFT minted” for bridge flow) |

**Frontend:** Set `NEXT_PUBLIC_DEBUG_CCIP=true` to log CCIP context + tx hash to the browser console.

## CCIP gas limits (CCIPBridge)

Cross-chain buy uses **three** configurable gas knobs (set by owner after deployment if needed):

| Variable | Role |
| -------- | ---- |
| `listingChainReceiveGasLimit` | Buyer → listing chain message. Must be **high enough** for the listing chain to run `finalizeRemotePurchaseToBridge` **and** send the return CCIP in the **same** execution (local mocks nest both; real CCIP is per-chain but fees are estimated from the same message shape). |
| `returnDestinationGasLimit` | Listing chain → buyer chain return (`REMOTE_PURCHASE_FULFILL`: mint wrapped + pay seller). |
| `bridgeOutGasLimit` | Normal NFT bridge-out (`bridgeOut`), not the marketplace buy path. |

Defaults are set in the `CCIPBridge` constructor. If a testnet **reverts** with `NotEnoughGasForCall` (Chainlink `CallWithExactGas`), raise `listingChainReceiveGasLimit` / `returnDestinationGasLimit` via the owner setters.

## eth_getLogs / Alchemy limits (429)

The app loads chain events in **≤10-block chunks** with **retries**, **exponential backoff on HTTP 429 / rate limits**, and a **small delay between chunks** (default **75ms** in `chunkedLogs.ts`) so Alchemy free tiers are less likely to return **429 Too Many Requests**. **Per-chain cursors** in `localStorage` (`blockestate_log_cursor_v1:*`) track the last scanned block so routine refreshes only query **new** blocks. Clear site data if you need a full historical rescan.

## Marketplace: listings not showing

The dashboard defaults to **show all active listings** (verified filter off). If **Verified Only** is enabled, listings still in validator review are hidden. Data is fetched live via `getListedTokenIds` + `getListing` — refresh or wait for the `marketplace-listings-updated` event after listing.

## Activity page: "View Source" and CCIP tracking

- **View Source** links to the chain where the buy transaction was sent (the **buyer chain**, e.g. Polygon Amoy). For Sepolia→Amoy buys, the source tx is on Amoy, not Sepolia — so use **View on Blockscan** if the chain-specific link fails.
- **View on Blockscan (multi-chain)** finds the transaction across all supported chains.
- **CCIP message status** (when messageId is available) opens [ccip.chain.link](https://ccip.chain.link/) to track the message. New cross-chain buys capture messageId automatically.

## Deployment: demo users + LINK

`scripts/deployAllChains.js` registers two demo addresses via `Verification.addUser` on **each** chain (each receives **1M BRT** via `initialUserMint`). It then **attempts** to fund each `CCIPBridge` with LINK (`FUND_BRIDGE_LINK_AMOUNT`, default **0.5**), skipping with a warning if the deployer wallet has insufficient LINK. Run manually if needed:

`npx hardhat run scripts/fundBridgeLink.js --network sepolia`  
`npx hardhat run scripts/fundBridgeLink.js --network amoy`

Read-only CCIP checks: `npx hardhat run scripts/e2eCrossChainBuy.js --network sepolia` (or `amoy`).

If **Peer bridge not set** / `trustedBridges(...) == 0x0`, run **`npx hardhat run scripts/setTrustedBridges.js`** (uses `config.json` + `PRIVATE_KEY`) to call `setTrustedBridge` on **both** chains. Same wiring runs at the end of `deployAllChains.js` if you deploy both networks in one go.

If **Sepolia succeeds** but **Amoy** fails (`processing response error`, timeout, etc.): fund **POL** on the deployer for Amoy, check `AMOY_RPC` (Alchemy can rate-limit); then retry **only Amoy** with  
`SKIP_SEPOLIA=1 npx hardhat run scripts/setTrustedBridges.js`  
(Amoy txs use Polygon **EIP-1559** gas from the fee API in `setTrustedBridges.js`.)

### Activity page: why it used to “load” forever

The page **renders tracked rows immediately** (local transfer records), then **fetches chain events in the background** so you are not blocked on dozens of sequential `eth_getLogs` calls. Log ranges use **`ACTIVITY_INITIAL_LOOKBACK` / `ACTIVITY_MAX_CATCHUP_PER_RUN`** (see `chunkedLogs.ts`) instead of very large catch-up windows.

## Race condition (MVP)

If another wallet **buys the same listing on the listing chain** (normal `buyProperty`) **before** your CCIP message executes, `finalizeRemotePurchaseToBridge` reverts on the listing chain. Your **outbound CCIP tx on the buyer chain has already succeeded** and **BRT remains escrowed** in `CCIPBridge` on that chain — there is **no automatic refund** in this MVP. For production, add reservations, refunds, or a dispute/claim flow.

## Deployment: CCIPBridge fails on Amoy (“transaction failed”)

Common causes:

1. **Out of gas** — `CCIPBridge` is large (~11.5k bytes of runtime code). A deploy `gasLimit` of ~2.5M can hit **OOG** on Polygon Amoy. The deploy script uses **5M** gas for deploy txs; retry with the latest `scripts/deployAllChains.js`.
2. **Wrong CCIP router** — `AMOY_CCIP_ROUTER` / `SEPOLIA_CCIP_ROUTER` must match [Chainlink’s current CCIP docs](https://docs.chain.link/ccip) for that testnet.
3. **Partial deploy** — If step `[5/5] CCIPBridge` fails, you still get BRT/NFT/Marketplace, so **same-chain `buyProperty` can work**, but **`Marketplace.setBridgeContract` never runs**, so **cross-chain buy / bridge UI will not work** until you deploy CCIPBridge successfully and wire the bridge (or run a repair script).

## Redeploy

Contracts changed: **`Marketplace`** (`finalizeRemotePurchaseToBridge`) and **`CCIPBridge`** (new actions + `crossChainBuyFromListing`). Re-run deployment and set `Marketplace.setBridgeContract` to the new bridge on each chain.

## Gas

Tune `CCIPBridge.setDestinationGasLimit` if fulfill mint + transfers fail on destination.
