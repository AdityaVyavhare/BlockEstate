/**
 * Comprehensive test suite for the Real Estate NFT Marketplace.
 *
 * Covers:
 *  - BRTToken: mint, transfer, approve, burn, bridge auth
 *  - PropertyNFT: mint, tokenURI, verification, access control
 *  - Verification: validators, voting, double-vote, majority logic
 *  - Marketplace: list, buy, delist, BRT fees, reverts
 *  - CCIPBridge: Chainlink MockCCIPRouter for cross-chain simulation
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Real Estate NFT Marketplace", function () {
  let owner, buyer, seller, validator1, validator2, validator3, feeRecipient;
  let brtToken, propertyNFT, verification, marketplace;
  let ccipBridgeSrc, mockRouter, linkToken;

  const INITIAL_SUPPLY = ethers.utils.parseEther("1000000");
  const PROPERTY_PRICE = ethers.utils.parseEther("1000");
  // Matches Verification.initialUserMint / initialValidatorMint default (1,000,000 BRT)
  const MINT_AMOUNT = ethers.utils.parseEther("1000000");
  const SEPOLIA_SELECTOR_BN = ethers.BigNumber.from("16015286601757825753");
  const AMOY_SELECTOR_BN = ethers.BigNumber.from("16281711391670634445");

  beforeEach(async function () {
    [owner, buyer, seller, validator1, validator2, validator3, feeRecipient] =
      await ethers.getSigners();

    // Deploy BRTToken
    const BRTToken = await ethers.getContractFactory("BRTToken");
    brtToken = await BRTToken.deploy("Bridge Token", "BRT");
    await brtToken.deployed();

    // Deploy PropertyNFT
    const PropertyNFT = await ethers.getContractFactory("PropertyNFT");
    propertyNFT = await PropertyNFT.deploy();
    await propertyNFT.deployed();

    // Deploy Verification
    const Verification = await ethers.getContractFactory("Verification");
    verification = await Verification.deploy(propertyNFT.address, brtToken.address);
    await verification.deployed();

    // Deploy Marketplace
    const Marketplace = await ethers.getContractFactory("Marketplace");
    marketplace = await Marketplace.deploy(
      brtToken.address,
      propertyNFT.address,
      verification.address
    );
    await marketplace.deployed();

    // Deploy Chainlink MockCCIPRouter (from @chainlink/contracts-ccip)
    const MockRouter = await ethers.getContractFactory("MockCCIPRouter");
    mockRouter = await MockRouter.deploy();
    await mockRouter.deployed();

    const MockLINK = await ethers.getContractFactory("MockLINK");
    linkToken = await MockLINK.deploy();
    await linkToken.deployed();
    await linkToken.mint(buyer.address, ethers.utils.parseEther("10000"));
    await linkToken.mint(owner.address, ethers.utils.parseEther("10000"));

    // Deploy CCIPBridge (using mock router + LINK for ccipSend / crossChainBuyFromListing)
    const CCIPBridge = await ethers.getContractFactory("CCIPBridge");
    ccipBridgeSrc = await CCIPBridge.deploy(
      brtToken.address,
      propertyNFT.address,
      marketplace.address,
      verification.address,
      mockRouter.address,
      SEPOLIA_SELECTOR_BN,
      linkToken.address
    );
    await ccipBridgeSrc.deployed();

    // Wire permissions
    await propertyNFT.setVerificationContract(verification.address);
    await propertyNFT.setMarketplaceContract(marketplace.address);
    await propertyNFT.setBridgeContract(ccipBridgeSrc.address);
    await brtToken.setBridge(ccipBridgeSrc.address, true);
    await brtToken.setBridge(verification.address, true);
    await marketplace.setBridgeContract(ccipBridgeSrc.address);

    // Add validators
    await verification.addValidator(validator1.address);
    await verification.addValidator(validator2.address);
    await verification.addValidator(validator3.address);

    // Register buyer + seller as users (can both buy and sell).
    await verification.addUser(buyer.address);
    await verification.addUser(seller.address);
  });

  // ═══════════════════════════════════════════════════════
  //  BRT TOKEN TESTS
  // ═══════════════════════════════════════════════════════

  describe("BRTToken", function () {
    it("should mint initial supply to deployer", async function () {
      const balance = await brtToken.balanceOf(owner.address);
      expect(balance).to.equal(INITIAL_SUPPLY);
    });

    it("should allow owner to mint tokens", async function () {
      const amount = ethers.utils.parseEther("500");
      await brtToken.mint(buyer.address, amount);
      const balance = await brtToken.balanceOf(buyer.address);
      expect(balance).to.equal(MINT_AMOUNT.add(amount));
    });

    it("should allow owner to burn tokens", async function () {
      const amount = ethers.utils.parseEther("100");
      await brtToken.burn(buyer.address, amount);
      const balance = await brtToken.balanceOf(buyer.address);
      expect(balance).to.equal(MINT_AMOUNT.sub(amount));
    });

    it("should allow bridge to mint tokens", async function () {
      await brtToken.setBridge(validator1.address, true);
      const amount = ethers.utils.parseEther("100");
      await brtToken.connect(validator1).mint(buyer.address, amount);
      const balance = await brtToken.balanceOf(buyer.address);
      expect(balance).to.equal(MINT_AMOUNT.add(amount));
    });

    it("should reject mint from unauthorized address", async function () {
      await expect(
        brtToken
          .connect(buyer)
          .mint(buyer.address, ethers.utils.parseEther("100"))
      ).to.be.revertedWith("Not authorized");
    });

    it("should allow transfer and approval", async function () {
      const amount = ethers.utils.parseEther("50");
      await brtToken.connect(buyer).approve(seller.address, amount);
      await brtToken
        .connect(seller)
        .transferFrom(buyer.address, seller.address, amount);
      expect(await brtToken.balanceOf(seller.address)).to.equal(
        MINT_AMOUNT.add(amount)
      );
    });

    it("should update bridge authorization", async function () {
      await brtToken.setBridge(validator1.address, true);
      expect(await brtToken.bridges(validator1.address)).to.be.true;
      await brtToken.setBridge(validator1.address, false);
      expect(await brtToken.bridges(validator1.address)).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════
  //  PROPERTY NFT TESTS
  // ═══════════════════════════════════════════════════════

  describe("PropertyNFT", function () {
    const metadataCID = "QmTest123456789";

    it("should mint a property NFT", async function () {
      const tx = await propertyNFT.mintProperty(seller.address, metadataCID);
      const receipt = await tx.wait();

      const event = receipt.events.find((e) => e.event === "PropertyMinted");
      expect(event.args.tokenId).to.equal(1);
      expect(event.args.owner).to.equal(seller.address);
      expect(event.args.metadataCID).to.equal(metadataCID);
    });

    it("should return correct tokenURI", async function () {
      await propertyNFT.mintProperty(seller.address, metadataCID);
      const uri = await propertyNFT.tokenURI(1);
      expect(uri).to.equal(`ipfs://${metadataCID}`);
    });

    it("should return correct metadata CID", async function () {
      await propertyNFT.mintProperty(seller.address, metadataCID);
      const cid = await propertyNFT.getMetadataCID(1);
      expect(cid).to.equal(metadataCID);
    });

    it("should reject minting with empty CID", async function () {
      await expect(
        propertyNFT.mintProperty(seller.address, "")
      ).to.be.revertedWith("Empty CID");
    });

    it("should track total supply", async function () {
      await propertyNFT.mintProperty(seller.address, "CID1");
      await propertyNFT.mintProperty(buyer.address, "CID2");
      expect(await propertyNFT.totalSupply()).to.equal(2);
    });

    it("should only allow verification contract to set verified", async function () {
      await propertyNFT.mintProperty(seller.address, metadataCID);
      await expect(propertyNFT.setVerified(1, true)).to.be.revertedWith(
        "Only verification contract"
      );
    });

    it("should only allow marketplace/bridge to transfer", async function () {
      await propertyNFT.mintProperty(seller.address, metadataCID);
      await expect(
        propertyNFT.transferProperty(seller.address, buyer.address, 1)
      ).to.be.revertedWith("Only marketplace or bridge");
    });
  });

  // ═══════════════════════════════════════════════════════
  //  VERIFICATION (MAJORITY VOTING) TESTS
  // ═══════════════════════════════════════════════════════

  describe("Verification", function () {
    let tokenId;

    beforeEach(async function () {
      const tx = await propertyNFT.mintProperty(
        seller.address,
        "QmTestProperty"
      );
      const receipt = await tx.wait();
      tokenId = receipt.events.find(
        (e) => e.event === "PropertyMinted"
      ).args.tokenId;
    });

    it("should add validators", async function () {
      expect(await verification.isValidator(validator1.address)).to.be.true;
      expect(await verification.isValidator(validator2.address)).to.be.true;
      expect(await verification.validatorCount()).to.equal(3);
    });

    it("should remove a validator", async function () {
      await verification.removeValidator(validator3.address);
      expect(await verification.isValidator(validator3.address)).to.be.false;
      expect(await verification.validatorCount()).to.equal(2);
    });

    it("should reject adding duplicate validator", async function () {
      await expect(
        verification.addValidator(validator1.address)
      ).to.be.revertedWith("Already a validator");
    });

    it("should allow validator to vote approve", async function () {
      await verification.connect(validator1).vote(tokenId, true);
      const [approvals, rejections, finalized] =
        await verification.getVerificationStatus(tokenId);
      expect(approvals).to.equal(1);
      expect(rejections).to.equal(0);
      expect(finalized).to.be.false;
    });

    it("should allow validator to vote reject", async function () {
      await verification.connect(validator1).vote(tokenId, false);
      const [approvals, rejections, finalized] =
        await verification.getVerificationStatus(tokenId);
      expect(approvals).to.equal(0);
      expect(rejections).to.equal(1);
      expect(finalized).to.be.false;
    });

    it("should prevent double voting", async function () {
      await verification.connect(validator1).vote(tokenId, true);
      await expect(
        verification.connect(validator1).vote(tokenId, true)
      ).to.be.revertedWith("Already voted");
    });

    it("should reject vote from non-validator", async function () {
      await expect(
        verification.connect(buyer).vote(tokenId, true)
      ).to.be.revertedWith("Not a validator");
    });

    it("should verify property when majority approves (2 of 3)", async function () {
      await verification.connect(validator1).vote(tokenId, true);
      await verification.connect(validator2).vote(tokenId, true);

      const [approvals, , finalized] =
        await verification.getVerificationStatus(tokenId);
      expect(approvals).to.equal(2);
      expect(finalized).to.be.true;
      expect(await propertyNFT.isVerified(tokenId)).to.be.true;
    });

    it("should reject property when majority rejects", async function () {
      await verification.connect(validator1).vote(tokenId, false);
      await verification.connect(validator2).vote(tokenId, false);

      const [, rejections, finalized] =
        await verification.getVerificationStatus(tokenId);
      expect(rejections).to.equal(2);
      expect(finalized).to.be.true;
      expect(await propertyNFT.isVerified(tokenId)).to.be.false;
    });

    it("should not verify with only 1 of 3 approvals", async function () {
      await verification.connect(validator1).vote(tokenId, true);

      const [approvals, , finalized] =
        await verification.getVerificationStatus(tokenId);
      expect(approvals).to.equal(1);
      expect(finalized).to.be.false;
    });

    it("should prevent voting after finalization", async function () {
      await verification.connect(validator1).vote(tokenId, true);
      await verification.connect(validator2).vote(tokenId, true);
      await expect(
        verification.connect(validator3).vote(tokenId, true)
      ).to.be.revertedWith("Already finalized");
    });

    it("should track hasVoted correctly", async function () {
      expect(await verification.hasVoted(tokenId, validator1.address)).to.be
        .false;
      await verification.connect(validator1).vote(tokenId, true);
      expect(await verification.hasVoted(tokenId, validator1.address)).to.be
        .true;
    });

    it("should reward validators with BRT on majority approval", async function () {
      const rewardPerVote = ethers.utils.parseEther("10");
      const v1Before = await brtToken.balanceOf(validator1.address);
      const v2Before = await brtToken.balanceOf(validator2.address);

      await verification.connect(validator1).vote(tokenId, true);
      await verification.connect(validator2).vote(tokenId, true);

      // Both approvers should receive 10 BRT each
      expect(await brtToken.balanceOf(validator1.address)).to.equal(
        v1Before.add(rewardPerVote)
      );
      expect(await brtToken.balanceOf(validator2.address)).to.equal(
        v2Before.add(rewardPerVote)
      );
    });
  });

  // ═══════════════════════════════════════════════════════
  //  MARKETPLACE TESTS
  // ═══════════════════════════════════════════════════════

  describe("Marketplace", function () {
    let tokenId;

    beforeEach(async function () {
      const tx = await propertyNFT.mintProperty(
        seller.address,
        "QmMarketProperty"
      );
      const receipt = await tx.wait();
      tokenId = receipt.events.find(
        (e) => e.event === "PropertyMinted"
      ).args.tokenId;

      // Verify the property (2 of 3 validators)
      await verification.connect(validator1).vote(tokenId, true);
      await verification.connect(validator2).vote(tokenId, true);
    });

    it("should list a verified property", async function () {
      await marketplace.connect(seller).listProperty(tokenId, PROPERTY_PRICE);
      const [listedSeller, price, active] = await marketplace.getListing(
        tokenId
      );
      expect(listedSeller).to.equal(seller.address);
      expect(price).to.equal(PROPERTY_PRICE);
      expect(active).to.be.true;
    });

    it("should reject listing unverified property", async function () {
      const tx2 = await propertyNFT.mintProperty(
        seller.address,
        "QmUnverified"
      );
      const receipt2 = await tx2.wait();
      const unverifiedId = receipt2.events.find(
        (e) => e.event === "PropertyMinted"
      ).args.tokenId;

      await expect(
        marketplace.connect(seller).listProperty(unverifiedId, PROPERTY_PRICE)
      ).to.be.revertedWith("Property not verified");
    });

    it("should reject listing by non-owner", async function () {
      await expect(
        marketplace.connect(buyer).listProperty(tokenId, PROPERTY_PRICE)
      ).to.be.revertedWith("Not the owner");
    });

    it("should reject listing with zero price", async function () {
      await expect(
        marketplace.connect(seller).listProperty(tokenId, 0)
      ).to.be.revertedWith("Price must be > 0");
    });

    it("should allow buying a listed property", async function () {
      await marketplace.connect(seller).listProperty(tokenId, PROPERTY_PRICE);
      await brtToken
        .connect(buyer)
        .approve(marketplace.address, PROPERTY_PRICE);

      await marketplace.connect(buyer).buyProperty(tokenId);

      expect(await propertyNFT.ownerOf(tokenId)).to.equal(buyer.address);
      const [, , active] = await marketplace.getListing(tokenId);
      expect(active).to.be.false;
    });

    it("should deduct correct platform fee (2%)", async function () {
      await marketplace.connect(seller).listProperty(tokenId, PROPERTY_PRICE);
      await brtToken
        .connect(buyer)
        .approve(marketplace.address, PROPERTY_PRICE);

      const sellerBefore = await brtToken.balanceOf(seller.address);
      const ownerBefore = await brtToken.balanceOf(owner.address);

      await marketplace.connect(buyer).buyProperty(tokenId);

      const fee = PROPERTY_PRICE.mul(200).div(10000); // 2%
      const sellerAmount = PROPERTY_PRICE.sub(fee);

      expect(await brtToken.balanceOf(seller.address)).to.equal(
        sellerBefore.add(sellerAmount)
      );
      expect(await brtToken.balanceOf(owner.address)).to.equal(
        ownerBefore.add(fee)
      );
    });

    it("should reject buying own property", async function () {
      await marketplace.connect(seller).listProperty(tokenId, PROPERTY_PRICE);
      await brtToken
        .connect(seller)
        .approve(marketplace.address, PROPERTY_PRICE);

      await expect(
        marketplace.connect(seller).buyProperty(tokenId)
      ).to.be.revertedWith("Cannot buy own property");
    });

    it("should allow delisting", async function () {
      await marketplace.connect(seller).listProperty(tokenId, PROPERTY_PRICE);
      await marketplace.connect(seller).delistProperty(tokenId);

      const [, , active] = await marketplace.getListing(tokenId);
      expect(active).to.be.false;
    });

    it("should reject delisting by non-seller", async function () {
      await marketplace.connect(seller).listProperty(tokenId, PROPERTY_PRICE);
      await expect(
        marketplace.connect(buyer).delistProperty(tokenId)
      ).to.be.revertedWith("Not the seller");
    });

    it("should reject buying unlisted property", async function () {
      await expect(
        marketplace.connect(buyer).buyProperty(tokenId)
      ).to.be.revertedWith("Not listed");
    });

    it("should allow updating platform fee", async function () {
      await marketplace.setPlatformFee(500);
      expect(await marketplace.platformFeeBps()).to.equal(500);
    });

    it("should reject fee > 10%", async function () {
      await expect(marketplace.setPlatformFee(1100)).to.be.revertedWith(
        "Fee too high"
      );
    });
  });

  // ═══════════════════════════════════════════════════════
  //  CCIP BRIDGE TESTS (MockCCIPRouter + crossChainBuyFromListing round-trip)
  // ═══════════════════════════════════════════════════════

  describe("CCIPBridge (crossChainBuyFromListing)", function () {
    let tokenId;

    async function approveBuyerForCrossChain(amountWei) {
      await brtToken.connect(buyer).approve(ccipBridgeSrc.address, amountWei);
      await linkToken
        .connect(buyer)
        .approve(ccipBridgeSrc.address, ethers.constants.MaxUint256);
    }

    beforeEach(async function () {
      const tx = await propertyNFT.mintProperty(
        seller.address,
        "QmBridgeProperty"
      );
      const receipt = await tx.wait();
      tokenId = receipt.events.find(
        (e) => e.event === "PropertyMinted"
      ).args.tokenId;

      await verification.connect(validator1).vote(tokenId, true);
      await verification.connect(validator2).vote(tokenId, true);

      await ccipBridgeSrc.setTrustedBridge(
        AMOY_SELECTOR_BN,
        ccipBridgeSrc.address
      );
      await ccipBridgeSrc.setTrustedBridge(
        SEPOLIA_SELECTOR_BN,
        ccipBridgeSrc.address
      );
    });

    it("should deploy with correct initial state", async function () {
      expect(await ccipBridgeSrc.brtToken()).to.equal(brtToken.address);
      expect(await ccipBridgeSrc.propertyNFT()).to.equal(propertyNFT.address);
      expect(await ccipBridgeSrc.linkToken()).to.equal(linkToken.address);
      expect(await ccipBridgeSrc.thisChainSelector()).to.equal(
        SEPOLIA_SELECTOR_BN
      );
      expect(await ccipBridgeSrc.getRouter()).to.equal(mockRouter.address);
    });

    it("should set trusted bridge", async function () {
      await ccipBridgeSrc.setTrustedBridge(AMOY_SELECTOR_BN, buyer.address);
      expect(await ccipBridgeSrc.trustedBridges(AMOY_SELECTOR_BN)).to.equal(
        buyer.address
      );
    });

    it("should emit TrustedBridgeUpdated event", async function () {
      await expect(
        ccipBridgeSrc.setTrustedBridge(AMOY_SELECTOR_BN, buyer.address)
      )
        .to.emit(ccipBridgeSrc, "TrustedBridgeUpdated")
        .withArgs(AMOY_SELECTOR_BN, buyer.address);
    });

    it("should only allow owner to set trusted bridge", async function () {
      await expect(
        ccipBridgeSrc
          .connect(buyer)
          .setTrustedBridge(AMOY_SELECTOR_BN, buyer.address)
      ).to.be.reverted;
    });

    it("should revert crossChainBuyFromListing to untrusted listing chain", async function () {
      const amount = ethers.utils.parseEther("1000");
      await marketplace.connect(seller).listProperty(tokenId, amount);
      await approveBuyerForCrossChain(amount);
      const fakeSel = ethers.BigNumber.from("9999999999999999999");
      await expect(
        ccipBridgeSrc
          .connect(buyer)
          .crossChainBuyFromListing(fakeSel, tokenId, amount)
      ).to.be.revertedWith("Untrusted listing chain");
    });

    it("should revert for non-user buyer", async function () {
      const amount = ethers.utils.parseEther("1000");
      await marketplace.connect(seller).listProperty(tokenId, amount);
      await expect(
        ccipBridgeSrc
          .connect(validator1)
          .crossChainBuyFromListing(AMOY_SELECTOR_BN, tokenId, amount)
      ).to.be.revertedWith("Not a user");
    });

    it("E2E (mock): listingChain = Amoy — wrapped NFT to buyer, seller paid BRT", async function () {
      const amount = ethers.utils.parseEther("1000");
      await marketplace.connect(seller).listProperty(tokenId, amount);
      await approveBuyerForCrossChain(amount);

      const tx = await ccipBridgeSrc
        .connect(buyer)
        .crossChainBuyFromListing(AMOY_SELECTOR_BN, tokenId, amount);
      const receipt = await tx.wait();

      const fulfilled = receipt.events.find(
        (e) => e.event === "CrossChainBuyFulfilled"
      );
      expect(fulfilled, "CrossChainBuyFulfilled").to.be.ok;
      const wrappedId = fulfilled.args.wrappedTokenId;
      expect(await propertyNFT.ownerOf(wrappedId)).to.equal(buyer.address);
      expect(await propertyNFT.isWrapped(wrappedId)).to.equal(true);

      const fee = amount.mul(200).div(10000);
      expect(await brtToken.balanceOf(seller.address)).to.equal(
        MINT_AMOUNT.add(amount.sub(fee))
      );
    });

    it("E2E (mock): listingChain = Sepolia — same round-trip succeeds", async function () {
      const amount = ethers.utils.parseEther("1000");
      await marketplace.connect(seller).listProperty(tokenId, amount);
      await approveBuyerForCrossChain(amount);

      const tx = await ccipBridgeSrc
        .connect(buyer)
        .crossChainBuyFromListing(SEPOLIA_SELECTOR_BN, tokenId, amount);
      const receipt = await tx.wait();

      expect(
        receipt.events.some((e) => e.event === "CCIPMessageReceived")
      ).to.equal(true);
      const fulfilled = receipt.events.find(
        (e) => e.event === "CrossChainBuyFulfilled"
      );
      expect(fulfilled).to.be.ok;
      const wrappedId = fulfilled.args.wrappedTokenId;
      expect(await propertyNFT.ownerOf(wrappedId)).to.equal(buyer.address);
    });

    it("should emit CrossChainBuyInitiated on outbound send", async function () {
      const amount = ethers.utils.parseEther("500");
      await marketplace.connect(seller).listProperty(tokenId, amount);
      await approveBuyerForCrossChain(amount);

      await expect(
        ccipBridgeSrc
          .connect(buyer)
          .crossChainBuyFromListing(AMOY_SELECTOR_BN, tokenId, amount)
      ).to.emit(ccipBridgeSrc, "CrossChainBuyInitiated");
    });

    it("should revert when listing price does not match escrow amount", async function () {
      const amount = ethers.utils.parseEther("1000");
      await marketplace.connect(seller).listProperty(tokenId, amount);
      await approveBuyerForCrossChain(ethers.utils.parseEther("999"));
      await expect(
        ccipBridgeSrc
          .connect(buyer)
          .crossChainBuyFromListing(
            AMOY_SELECTOR_BN,
            tokenId,
            ethers.utils.parseEther("999")
          )
      ).to.be.reverted;
    });

    it("should revert when listing inactive", async function () {
      const amount = ethers.utils.parseEther("400");
      await approveBuyerForCrossChain(amount);
      await expect(
        ccipBridgeSrc
          .connect(buyer)
          .crossChainBuyFromListing(AMOY_SELECTOR_BN, tokenId, amount)
      ).to.be.reverted;
    });

    it("should allow owner to withdraw ETH", async function () {
      await owner.sendTransaction({
        to: ccipBridgeSrc.address,
        value: ethers.utils.parseEther("0.1"),
      });

      const balBefore = await ethers.provider.getBalance(owner.address);
      await ccipBridgeSrc.withdrawETH();
      const balAfter = await ethers.provider.getBalance(owner.address);

      expect(balAfter).to.be.gt(
        balBefore.sub(ethers.utils.parseEther("0.01"))
      );
    });

    it("should accept ETH via receive", async function () {
      await owner.sendTransaction({
        to: ccipBridgeSrc.address,
        value: ethers.utils.parseEther("0.5"),
      });
      const balance = await ethers.provider.getBalance(ccipBridgeSrc.address);
      expect(balance).to.equal(ethers.utils.parseEther("0.5"));
    });
  });
});
