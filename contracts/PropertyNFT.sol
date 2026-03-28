// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PropertyNFT
 * @notice ERC721 representing real estate assets.
 *
 * Each token stores:
 *  - metadataCID (IPFS hash via Pinata)
 *  - verification status (set by Verification contract)
 *  - owner
 */
contract PropertyNFT is ERC721, ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    /// @notice Address of the Verification contract (allowed to set verified)
    address public verificationContract;

    /// @notice Address of the Marketplace contract (allowed to transfer)
    address public marketplaceContract;

    /// @notice Address of the Bridge contract (allowed to transfer)
    address public bridgeContract;

    /// @notice Metadata CID per token
    mapping(uint256 => string) public metadataCIDs;

    /// @notice Verification status per token
    mapping(uint256 => bool) public isVerified;

    /// @notice Whether token is a wrapped representation minted by bridge
    mapping(uint256 => bool) public isWrapped;

    struct WrappedOrigin {
        uint64 sourceChainSelector;
        address sourceContract;
        uint256 sourceTokenId;
    }
    mapping(uint256 => WrappedOrigin) private _wrappedOrigins;

    // ── Events ──────────────────────────────────────────────
    event PropertyMinted(
        uint256 indexed tokenId,
        address indexed owner,
        string metadataCID
    );
    event PropertyVerified(uint256 indexed tokenId, bool verified);
    event VerificationContractUpdated(address indexed newContract);
    event MarketplaceContractUpdated(address indexed newContract);
    event BridgeContractUpdated(address indexed newContract);
    event WrappedMinted(
        uint256 indexed tokenId,
        address indexed owner,
        uint64 indexed sourceChainSelector,
        address sourceContract,
        uint256 sourceTokenId
    );
    event WrappedBurned(
        uint256 indexed tokenId,
        uint64 indexed sourceChainSelector,
        address sourceContract,
        uint256 sourceTokenId
    );

    constructor() ERC721("RealEstateProperty", "REP") Ownable(msg.sender) {
        _nextTokenId = 1;
    }

    // ── Modifiers ───────────────────────────────────────────

    modifier onlyVerificationContract() {
        require(
            msg.sender == verificationContract,
            "Only verification contract"
        );
        _;
    }

    // ── Admin ───────────────────────────────────────────────

    function setVerificationContract(address _contract) external onlyOwner {
        require(_contract != address(0), "Zero address");
        verificationContract = _contract;
        emit VerificationContractUpdated(_contract);
    }

    function setMarketplaceContract(address _contract) external onlyOwner {
        require(_contract != address(0), "Zero address");
        marketplaceContract = _contract;
        emit MarketplaceContractUpdated(_contract);
    }

    function setBridgeContract(address _contract) external onlyOwner {
        require(_contract != address(0), "Zero address");
        bridgeContract = _contract;
        emit BridgeContractUpdated(_contract);
    }

    // ── Core Functions ──────────────────────────────────────

    /// @notice Mint a new property NFT with IPFS metadata
    function mintProperty(
        address owner_,
        string calldata metadataCID
    ) external returns (uint256) {
        require(bytes(metadataCID).length > 0, "Empty CID");

        uint256 tokenId = _nextTokenId++;
        _safeMint(owner_, tokenId);
        _setTokenURI(tokenId, string.concat("ipfs://", metadataCID));
        metadataCIDs[tokenId] = metadataCID;

        emit PropertyMinted(tokenId, owner_, metadataCID);
        return tokenId;
    }

    /// @notice Set verification status — only callable by Verification contract
    function setVerified(
        uint256 tokenId,
        bool verified
    ) external onlyVerificationContract {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        isVerified[tokenId] = verified;
        emit PropertyVerified(tokenId, verified);
    }

    /// @notice Transfer property for marketplace/bridge purchases
    function transferProperty(
        address from,
        address to,
        uint256 tokenId
    ) external {
        require(
            msg.sender == marketplaceContract || msg.sender == bridgeContract,
            "Only marketplace or bridge"
        );
        _transfer(from, to, tokenId);
    }

    /// @notice Mint a wrapped/mirror NFT representation for a bridged source token.
    function mintWrapped(
        address to,
        string calldata tokenUri_,
        uint64 sourceChainSelector,
        address sourceContract,
        uint256 sourceTokenId
    ) external returns (uint256) {
        require(msg.sender == bridgeContract, "Only bridge");
        require(to != address(0), "Zero recipient");
        require(sourceContract != address(0), "Zero source contract");
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, tokenUri_);
        isWrapped[tokenId] = true;
        _wrappedOrigins[tokenId] = WrappedOrigin({
            sourceChainSelector: sourceChainSelector,
            sourceContract: sourceContract,
            sourceTokenId: sourceTokenId
        });
        emit WrappedMinted(
            tokenId,
            to,
            sourceChainSelector,
            sourceContract,
            sourceTokenId
        );
        return tokenId;
    }

    /// @notice Burn a wrapped NFT before releasing original on source chain.
    function burnWrapped(uint256 tokenId, address owner_) external {
        require(msg.sender == bridgeContract, "Only bridge");
        require(isWrapped[tokenId], "Not wrapped");
        require(ownerOf(tokenId) == owner_, "Not wrapped owner");
        WrappedOrigin memory origin = _wrappedOrigins[tokenId];
        _burn(tokenId);
        delete isWrapped[tokenId];
        delete _wrappedOrigins[tokenId];
        emit WrappedBurned(
            tokenId,
            origin.sourceChainSelector,
            origin.sourceContract,
            origin.sourceTokenId
        );
    }

    function getWrappedOrigin(
        uint256 tokenId
    )
        external
        view
        returns (
            uint64 sourceChainSelector,
            address sourceContract,
            uint256 sourceTokenId
        )
    {
        WrappedOrigin memory o = _wrappedOrigins[tokenId];
        return (o.sourceChainSelector, o.sourceContract, o.sourceTokenId);
    }

    /// @notice Get the metadata CID for a token
    function getMetadataCID(
        uint256 tokenId
    ) external view returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        return metadataCIDs[tokenId];
    }

    /// @notice Backwards-compatible helper for the required API.
    /// @dev ERC721 already exposes `tokenURI(tokenId)`; this wrapper satisfies
    /// the requested `getTokenURI(tokenId)` function name.
    function getTokenURI(uint256 tokenId) external view returns (string memory) {
        return tokenURI(tokenId);
    }

    /// @notice Get total number of minted properties
    function totalSupply() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    // ── Overrides ───────────────────────────────────────────

    function tokenURI(
        uint256 tokenId
    ) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, ERC721URIStorage) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
