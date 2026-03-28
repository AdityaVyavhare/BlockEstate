// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Marketplace
 * @notice BRT-based property marketplace for listing and buying real estate NFTs.
 *
 * Features:
 *  - List verified properties for sale (BRT price)
 *  - Buy properties using BRT tokens
 *  - 2% platform fee on purchases
 *  - Reentrancy protection
 */

interface IMarketBRT {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IMarketPropertyNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function isVerified(uint256 tokenId) external view returns (bool);
    function transferProperty(address from, address to, uint256 tokenId) external;
}

interface IVerificationUsers {
    function isUser(address user) external view returns (bool);
}

contract Marketplace is Ownable, ReentrancyGuard {
    IMarketBRT public brtToken;
    IMarketPropertyNFT public propertyNFT;
    IVerificationUsers public verification;

    /// @notice Platform fee percentage (in basis points, 200 = 2%)
    uint256 public platformFeeBps = 200;

    /// @notice Address to receive platform fees
    address public feeRecipient;

    // ── Listing ─────────────────────────────────────────────

    struct Listing {
        address seller;
        uint256 price; // in BRT (wei)
        bool active;
    }

    mapping(uint256 => Listing) public listings;
    uint256[] public listedTokenIds;

    /// @notice Address allowed to finalize cross-chain sales.
    address public bridgeContract;

    // ── Events ──────────────────────────────────────────────
    event PropertyListed(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price
    );
    /// @notice Mirrors PropertyListed — for explorers / indexers that filter on `ListingCreated`.
    event ListingCreated(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price
    );
    event PropertyDelisted(uint256 indexed tokenId, address indexed seller);
    event PropertySold(
        uint256 indexed tokenId,
        address indexed buyer,
        address indexed seller,
        uint256 price,
        uint256 fee
    );
    event PlatformFeeUpdated(uint256 newFeeBps);
    event FeeRecipientUpdated(address newRecipient);

    constructor(
        address _brtToken,
        address _propertyNFT,
        address _verification
    ) Ownable(msg.sender) {
        require(_brtToken != address(0), "Zero BRT address");
        require(_propertyNFT != address(0), "Zero NFT address");
        require(_verification != address(0), "Zero verification address");
        brtToken = IMarketBRT(_brtToken);
        propertyNFT = IMarketPropertyNFT(_propertyNFT);
        verification = IVerificationUsers(_verification);
        feeRecipient = msg.sender;
    }

    // ── Admin ───────────────────────────────────────────────

    function setPlatformFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 1000, "Fee too high"); // Max 10%
        platformFeeBps = _feeBps;
        emit PlatformFeeUpdated(_feeBps);
    }

    function setFeeRecipient(address _recipient) external onlyOwner {
        require(_recipient != address(0), "Zero address");
        feeRecipient = _recipient;
        emit FeeRecipientUpdated(_recipient);
    }

    // ── Listing Functions ───────────────────────────────────

    /// @notice List a verified property for sale
    function listProperty(uint256 tokenId, uint256 price) external {
        require(verification.isUser(msg.sender), "Not a user");
        require(price > 0, "Price must be > 0");
        require(
            propertyNFT.ownerOf(tokenId) == msg.sender,
            "Not the owner"
        );
        require(propertyNFT.isVerified(tokenId), "Property not verified");
        require(!listings[tokenId].active, "Already listed");

        listings[tokenId] = Listing({
            seller: msg.sender,
            price: price,
            active: true
        });

        listedTokenIds.push(tokenId);

        emit PropertyListed(tokenId, msg.sender, price);
        emit ListingCreated(tokenId, msg.sender, price);
    }

    /// @notice Remove a listing
    function delistProperty(uint256 tokenId) external {
        Listing storage listing = listings[tokenId];
        require(listing.active, "Not listed");
        require(listing.seller == msg.sender, "Not the seller");

        listing.active = false;
        emit PropertyDelisted(tokenId, msg.sender);
    }

    /// @notice Buy a listed property using BRT tokens
    function buyProperty(uint256 tokenId) external nonReentrant {
        require(verification.isUser(msg.sender), "Not a user");
        Listing storage listing = listings[tokenId];
        require(listing.active, "Not listed");
        require(listing.seller != msg.sender, "Cannot buy own property");

        uint256 price = listing.price;
        address seller = listing.seller;

        // Integrity checks in case ownership/listing changed after listing.
        require(propertyNFT.ownerOf(tokenId) == seller, "Seller no longer owns NFT");
        require(propertyNFT.isVerified(tokenId), "Property not verified");

        // Calculate platform fee
        uint256 fee = (price * platformFeeBps) / 10000;
        uint256 sellerAmount = price - fee;

        // Transfer BRT from buyer
        require(
            brtToken.transferFrom(msg.sender, seller, sellerAmount),
            "BRT transfer to seller failed"
        );

        if (fee > 0) {
            require(
                brtToken.transferFrom(msg.sender, feeRecipient, fee),
                "BRT fee transfer failed"
            );
        }

        // Transfer NFT from seller to buyer
        propertyNFT.transferProperty(seller, msg.sender, tokenId);

        // Mark listing as inactive
        listing.active = false;

        emit PropertySold(tokenId, msg.sender, seller, price, fee);
    }

    /// @notice Listing chain only: close listing and move NFT into the bridge (locked).
    ///         BRT is paid on the buyer's home chain inside CCIPBridge (REMOTE_PURCHASE_FULFILL).
    function finalizeRemotePurchaseToBridge(
        uint256 tokenId,
        address remoteBuyer,
        uint256 amount
    ) external nonReentrant {
        require(msg.sender == bridgeContract, "Only bridge");
        Listing storage listing = listings[tokenId];
        require(listing.active, "Not listed");
        require(listing.price == amount, "Price mismatch");

        address seller = listing.seller;
        require(seller != remoteBuyer, "Invalid buyer");
        require(propertyNFT.ownerOf(tokenId) == seller, "Seller no longer owns NFT");
        require(propertyNFT.isVerified(tokenId), "Property not verified");

        listing.active = false;

        uint256 fee = (amount * platformFeeBps) / 10000;

        propertyNFT.transferProperty(seller, bridgeContract, tokenId);

        emit PropertySold(tokenId, remoteBuyer, seller, amount, fee);
    }

    function setBridgeContract(address _bridge) external onlyOwner {
        require(_bridge != address(0), "Zero bridge");
        bridgeContract = _bridge;
    }

    // ── View Functions ──────────────────────────────────────

    /// @notice Get all listed token IDs (includes inactive — filter on frontend)
    function getListedTokenIds() external view returns (uint256[] memory) {
        return listedTokenIds;
    }

    /// @notice Get listing details
    function getListing(
        uint256 tokenId
    ) external view returns (address seller, uint256 price, bool active) {
        Listing storage l = listings[tokenId];
        return (l.seller, l.price, l.active);
    }

    /// @notice Get count of all-time listings
    function getListingCount() external view returns (uint256) {
        return listedTokenIds.length;
    }
}
