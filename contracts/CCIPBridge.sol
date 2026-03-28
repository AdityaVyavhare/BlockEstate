// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CCIPReceiver} from "@chainlink/contracts-ccip/src/v0.8/ccip/applications/CCIPReceiver.sol";
import {Client} from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IRouterClient.sol";

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CCIPBridge
 * @notice Cross-chain NFT bridge using Chainlink CCIP.
 *
 * CCIP Flow (3 stages):
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ 1. SOURCE CHAIN (Send)                                                   │
 * │    User calls bridgeOut() → encodes (tokenId, receiver) → pays LINK fee  │
 * │    → ccipSend(destinationChainSelector, message)                         │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ 2. CCIP NETWORK (Route & Verify)                                         │
 * │    Chainlink validates & routes message. No user interaction.            │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ 3. DESTINATION CHAIN (Receive)                                           │
 * │    CCIP router calls _ccipReceive(message) → decode → mint or transfer   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Features: minimal payload, LINK fee token, configurable dest gas.
 */

interface IBridgePropertyNFT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferProperty(address from, address to, uint256 tokenId) external;
    function isWrapped(uint256 tokenId) external view returns (bool);
    function mintWrapped(
        address to,
        string calldata tokenUri_,
        uint64 sourceChainSelector,
        address sourceContract,
        uint256 sourceTokenId
    ) external returns (uint256);
    function burnWrapped(uint256 tokenId, address owner_) external;
    function getWrappedOrigin(uint256 tokenId)
        external
        view
        returns (uint64 sourceChainSelector, address sourceContract, uint256 sourceTokenId);
}

interface IMarketplaceXBuy {
    function finalizeRemotePurchaseToBridge(uint256 tokenId, address remoteBuyer, uint256 amount) external;
    function getListing(uint256 tokenId)
        external
        view
        returns (address seller, uint256 price, bool active);
    function platformFeeBps() external view returns (uint256);
    function feeRecipient() external view returns (address);
}

interface IBridgeVerification {
    function isUser(address user) external view returns (bool);
}

contract CCIPBridge is CCIPReceiver, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IBridgePropertyNFT public propertyNFT;
    IERC20 public linkToken;
    IERC20 public brtToken;
    IMarketplaceXBuy public marketplace;
    IBridgeVerification public verification;

    uint64 public thisChainSelector;

    mapping(uint64 => address) public trustedBridges;
    mapping(bytes32 => bool) public processedMessages;

    enum BridgeAction {
        MINT_WRAPPED,
        RELEASE_ORIGINAL,
        REMOTE_PURCHASE_REQUEST,
        REMOTE_PURCHASE_FULFILL
    }

    /// @notice Gas passed to CCIP for `bridgeOut` (mint wrapped / release original on dest).
    uint256 public bridgeOutGasLimit;
    /// @notice Gas for buyer → listing chain leg of cross-chain buy (must cover finalize + nested return send in testnet mocks).
    uint256 public listingChainReceiveGasLimit;
    /// @notice Gas for listing chain → buyer chain return leg (`REMOTE_PURCHASE_FULFILL`).
    uint256 public returnDestinationGasLimit;

    event BridgeOutInitiated(
        bytes32 indexed messageId,
        address indexed user,
        uint256 indexed localTokenId,
        uint64 destChainSelector
    );
    event WrappedMintedOnDestination(
        bytes32 indexed messageId,
        address indexed recipient,
        uint256 indexed wrappedTokenId,
        uint64 sourceChainSelector,
        address sourceContract,
        uint256 sourceTokenId
    );
    event OriginalReleasedOnDestination(
        bytes32 indexed messageId,
        address indexed recipient,
        uint256 indexed originalTokenId
    );
    event TrustedBridgeUpdated(uint64 chainSelector, address bridge);
    event BridgeOutGasLimitUpdated(uint256 newLimit);
    event ListingChainReceiveGasLimitUpdated(uint256 newLimit);
    event ReturnDestinationGasLimitUpdated(uint256 newLimit);
    event CrossChainBuyInitiated(
        bytes32 indexed messageId,
        address indexed buyer,
        uint256 indexed listingTokenId,
        uint64 listingChainSelector
    );
    event CrossChainBuyFulfilled(
        bytes32 indexed messageId,
        address indexed buyer,
        uint256 wrappedTokenId,
        uint64 originChainSelector,
        address originNft,
        uint256 originTokenId
    );
    /// @notice Emitted after each successful `ccipSend` (outbound CCIP message).
    event CCIPMessageSent(bytes32 indexed messageId, uint64 indexed destChainSelector);
    /// @notice Emitted when `_ccipReceive` accepts a message (after trust checks).
    event CCIPMessageReceived(bytes32 indexed messageId, uint64 indexed sourceChainSelector);

    constructor(
        address _brtToken,
        address _propertyNFT,
        address _marketplace,
        address _verification,
        address _ccipRouter,
        uint64 _chainSelector,
        address _linkToken
    ) CCIPReceiver(_ccipRouter) Ownable(msg.sender) {
        require(_propertyNFT != address(0), "Zero NFT");
        require(_linkToken != address(0), "Zero LINK");
        require(_brtToken != address(0), "Zero BRT");
        require(_marketplace != address(0), "Zero marketplace");
        require(_verification != address(0), "Zero verification");

        propertyNFT = IBridgePropertyNFT(_propertyNFT);
        brtToken = IERC20(_brtToken);
        marketplace = IMarketplaceXBuy(_marketplace);
        verification = IBridgeVerification(_verification);
        thisChainSelector = _chainSelector;
        linkToken = IERC20(_linkToken);
        bridgeOutGasLimit = 500_000;
        listingChainReceiveGasLimit = 2_500_000;
        returnDestinationGasLimit = 450_000;
    }

    function setTrustedBridge(uint64 chainSelector, address bridge) external onlyOwner {
        trustedBridges[chainSelector] = bridge;
        emit TrustedBridgeUpdated(chainSelector, bridge);
    }

    function setBridgeOutGasLimit(uint256 _gasLimit) external onlyOwner {
        require(_gasLimit >= 200_000 && _gasLimit <= 3_000_000, "Gas out of range");
        bridgeOutGasLimit = _gasLimit;
        emit BridgeOutGasLimitUpdated(_gasLimit);
    }

    function setListingChainReceiveGasLimit(uint256 _gasLimit) external onlyOwner {
        require(_gasLimit >= 500_000 && _gasLimit <= 5_000_000, "Gas out of range");
        listingChainReceiveGasLimit = _gasLimit;
        emit ListingChainReceiveGasLimitUpdated(_gasLimit);
    }

    function setReturnDestinationGasLimit(uint256 _gasLimit) external onlyOwner {
        require(_gasLimit >= 200_000 && _gasLimit <= 2_000_000, "Gas out of range");
        returnDestinationGasLimit = _gasLimit;
        emit ReturnDestinationGasLimitUpdated(_gasLimit);
    }

    /// @notice Anyone can top up LINK on the listing-side bridge so it can pay the return CCIP message.
    function fundReturnLink(uint256 amount) external {
        linkToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice LINK fee for the outbound leg (buyer chain → listing chain). Buyer pays this in `crossChainBuyFromListing`.
    function getCrossChainBuyLinkFee(
        uint64 listingChainSelector,
        address buyer,
        uint256 listingTokenId,
        uint256 listingPriceWei
    ) external view returns (uint256) {
        require(trustedBridges[listingChainSelector] != address(0), "Untrusted listing chain");
        bytes memory payload = abi.encode(
            uint8(BridgeAction.REMOTE_PURCHASE_REQUEST),
            buyer,
            listingTokenId,
            listingPriceWei
        );
        return _getBridgeFee(listingChainSelector, payload, listingChainReceiveGasLimit);
    }

    /**
     * @notice True cross-chain marketplace buy: pay BRT on this chain, stay on this chain.
     *         Listing must live on `listingChainSelector`. Escrowed BRT is released to seller when fulfill arrives.
     *         @dev Listing-side bridge must hold enough LINK to pay the return CCIP message (fundReturnLink).
     */
    function crossChainBuyFromListing(
        uint64 listingChainSelector,
        uint256 listingTokenId,
        uint256 listingPriceWei
    ) external nonReentrant {
        require(trustedBridges[listingChainSelector] != address(0), "Untrusted listing chain");
        require(verification.isUser(msg.sender), "Not a user");

        brtToken.safeTransferFrom(msg.sender, address(this), listingPriceWei);

        bytes memory payload = abi.encode(
            uint8(BridgeAction.REMOTE_PURCHASE_REQUEST),
            msg.sender,
            listingTokenId,
            listingPriceWei
        );

        uint256 linkFee = _getBridgeFee(listingChainSelector, payload, listingChainReceiveGasLimit);
        linkToken.safeTransferFrom(msg.sender, address(this), linkFee);
        linkToken.forceApprove(getRouter(), linkFee);

        Client.EVM2AnyMessage memory ccipMessage = _buildCcipMessage(
            trustedBridges[listingChainSelector],
            payload,
            listingChainReceiveGasLimit
        );
        IRouterClient router = IRouterClient(getRouter());
        bytes32 messageId = router.ccipSend(listingChainSelector, ccipMessage);
        emit CCIPMessageSent(messageId, listingChainSelector);

        emit CrossChainBuyInitiated(messageId, msg.sender, listingTokenId, listingChainSelector);
    }

    /// @notice [STAGE 1] Source chain: user initiates cross-chain transfer.
    ///         Encodes payload, pays LINK fee, calls ccipSend().
    function bridgeOut(uint64 destChainSelector, uint256 tokenId) external nonReentrant {
        require(trustedBridges[destChainSelector] != address(0), "Untrusted destination");
        require(propertyNFT.ownerOf(tokenId) == msg.sender, "Not owner");

        // 1a. Prepare message (encode tokenId, receiver, action)
        bytes memory payload;
        if (propertyNFT.isWrapped(tokenId)) {
            (
                uint64 originChain,
                address originContract,
                uint256 originTokenId
            ) = propertyNFT.getWrappedOrigin(tokenId);
            require(destChainSelector == originChain, "Must bridge back to origin");

            propertyNFT.burnWrapped(tokenId, msg.sender);
            // Minimal: action, receiver, originChain, originContract, originTokenId
            payload = abi.encode(
                uint8(BridgeAction.RELEASE_ORIGINAL),
                msg.sender,
                originChain,
                originContract,
                originTokenId
            );
        } else {
            propertyNFT.transferProperty(msg.sender, address(this), tokenId);
            // Minimal: action, receiver, originContract, originTokenId (originChain from message)
            payload = abi.encode(
                uint8(BridgeAction.MINT_WRAPPED),
                msg.sender,
                address(propertyNFT),
                tokenId
            );
        }

        // 1b. Pay CCIP fee in LINK
        uint256 linkFee = _getBridgeFee(destChainSelector, payload, bridgeOutGasLimit);
        linkToken.safeTransferFrom(msg.sender, address(this), linkFee);
        linkToken.forceApprove(getRouter(), linkFee);

        // 1c. ccipSend() → message sent to CCIP network
        Client.EVM2AnyMessage memory ccipMessage = _buildCcipMessage(
            trustedBridges[destChainSelector],
            payload,
            bridgeOutGasLimit
        );
        IRouterClient router = IRouterClient(getRouter());
        bytes32 messageId = router.ccipSend(destChainSelector, ccipMessage);
        emit CCIPMessageSent(messageId, destChainSelector);

        emit BridgeOutInitiated(messageId, msg.sender, tokenId, destChainSelector);
    }

    /// @notice [STAGE 3] Destination chain: CCIP router calls this when message arrives.
    ///         Decode data → execute mint or transfer.
    function _ccipReceive(Client.Any2EVMMessage memory message) internal override {
        require(!processedMessages[message.messageId], "Already processed");

        // 3a. Validate source is trusted bridge
        address sourceSender = abi.decode(message.sender, (address));
        require(
            trustedBridges[message.sourceChainSelector] == sourceSender,
            "Untrusted source"
        );

        processedMessages[message.messageId] = true;
        emit CCIPMessageReceived(message.messageId, message.sourceChainSelector);

        // 3b. Decode data
        uint8 actionRaw = abi.decode(message.data, (uint8));
        BridgeAction action = BridgeAction(actionRaw);

        // 3c. Execute logic: mint wrapped or release original
        if (action == BridgeAction.MINT_WRAPPED) {
            (, address recipient, address originContract, uint256 originTokenId) =
                abi.decode(message.data, (uint8, address, address, uint256));
            uint64 originChain = message.sourceChainSelector;

            string memory uri = _wrappedPlaceholderUri(originChain, originContract, originTokenId);
            uint256 wrappedTokenId = propertyNFT.mintWrapped(
                recipient,
                uri,
                originChain,
                originContract,
                originTokenId
            );

            emit WrappedMintedOnDestination(
                message.messageId,
                recipient,
                wrappedTokenId,
                originChain,
                originContract,
                originTokenId
            );
        } else if (action == BridgeAction.RELEASE_ORIGINAL) {
            (, address recipient, uint64 originChain, address originContract, uint256 originTokenId) =
                abi.decode(message.data, (uint8, address, uint64, address, uint256));

            require(originChain == thisChainSelector, "Wrong release chain");
            require(originContract == address(propertyNFT), "Wrong release contract");

            propertyNFT.transferProperty(address(this), recipient, originTokenId);
            emit OriginalReleasedOnDestination(
                message.messageId,
                recipient,
                originTokenId
            );
        } else if (action == BridgeAction.REMOTE_PURCHASE_REQUEST) {
            _handleRemotePurchaseRequest(message);
        } else if (action == BridgeAction.REMOTE_PURCHASE_FULFILL) {
            _handleRemotePurchaseFulfill(message);
        } else {
            revert("Unknown action");
        }
    }

    function _handleRemotePurchaseRequest(Client.Any2EVMMessage memory message) private {
        (, address buyer, uint256 tokenId, uint256 price) =
            abi.decode(message.data, (uint8, address, uint256, uint256));
        (address seller,, bool active) = marketplace.getListing(tokenId);
        require(active, "Inactive listing");
        require(seller != buyer, "Bad buyer");

        marketplace.finalizeRemotePurchaseToBridge(tokenId, buyer, price);

        bytes memory returnData = abi.encode(
            uint8(BridgeAction.REMOTE_PURCHASE_FULFILL),
            buyer,
            seller,
            tokenId,
            price,
            address(propertyNFT)
        );

        uint64 backSelector = message.sourceChainSelector;
        address destBridge = trustedBridges[backSelector];
        require(destBridge != address(0), "No peer bridge");

        uint256 returnFee = _getBridgeFee(backSelector, returnData, returnDestinationGasLimit);
        require(linkToken.balanceOf(address(this)) >= returnFee, "Insufficient LINK for CCIP return");

        linkToken.forceApprove(getRouter(), returnFee);
        Client.EVM2AnyMessage memory outMsg = _buildCcipMessage(destBridge, returnData, returnDestinationGasLimit);
        bytes32 returnMessageId = IRouterClient(getRouter()).ccipSend(backSelector, outMsg);
        emit CCIPMessageSent(returnMessageId, backSelector);
    }

    function _handleRemotePurchaseFulfill(Client.Any2EVMMessage memory message) private {
        (, address buyer, address seller, uint256 originTokenId, uint256 price, address originNft) =
            abi.decode(message.data, (uint8, address, address, uint256, uint256, address));

        require(brtToken.balanceOf(address(this)) >= price, "Missing BRT escrow");

        uint256 fee = (price * marketplace.platformFeeBps()) / 10_000;
        uint256 sellerAmt = price - fee;
        address feeRec = marketplace.feeRecipient();

        uint256 wrappedId = propertyNFT.mintWrapped(
            buyer,
            _wrappedPlaceholderUri(message.sourceChainSelector, originNft, originTokenId),
            message.sourceChainSelector,
            originNft,
            originTokenId
        );

        brtToken.safeTransfer(seller, sellerAmt);
        if (fee > 0) {
            brtToken.safeTransfer(feeRec, fee);
        }

        emit CrossChainBuyFulfilled(
            message.messageId,
            buyer,
            wrappedId,
            message.sourceChainSelector,
            originNft,
            originTokenId
        );
    }

    /// @dev Deterministic placeholder URI; frontend fetches real metadata from source chain.
    function _wrappedPlaceholderUri(
        uint64 originChain,
        address originContract,
        uint256 originTokenId
    ) internal pure returns (string memory) {
        bytes32 h = keccak256(abi.encode(originChain, originContract, originTokenId));
        return string.concat("ipfs://bridge/", _toHexString(uint256(h)));
    }

    function _toHexString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 length;
        while (temp != 0) {
            length++;
            temp >>= 4;
        }
        bytes memory buffer = new bytes(length);
        unchecked {
            for (uint256 i = length; i > 0; --i) {
                buffer[i - 1] = _HEX_CHARS[value & 0xf];
                value >>= 4;
            }
        }
        return string(buffer);
    }

    bytes16 private constant _HEX_CHARS = "0123456789abcdef";

    function getBridgeFee(uint64 destChainSelector, uint256 tokenId)
        external
        view
        returns (uint256)
    {
        require(trustedBridges[destChainSelector] != address(0), "Untrusted destination");
        bool wrapped = propertyNFT.isWrapped(tokenId);
        bytes memory payload;
        if (wrapped) {
            (
                uint64 originChain,
                address originContract,
                uint256 originTokenId
            ) = propertyNFT.getWrappedOrigin(tokenId);
            payload = abi.encode(
                uint8(BridgeAction.RELEASE_ORIGINAL),
                msg.sender,
                originChain,
                originContract,
                originTokenId
            );
        } else {
            payload = abi.encode(
                uint8(BridgeAction.MINT_WRAPPED),
                msg.sender,
                address(propertyNFT),
                tokenId
            );
        }
        return _getBridgeFee(destChainSelector, payload, bridgeOutGasLimit);
    }

    function _buildCcipMessage(
        address destBridge,
        bytes memory payload,
        uint256 gasLimitForMsg
    ) internal view returns (Client.EVM2AnyMessage memory) {
        return Client.EVM2AnyMessage({
            receiver: abi.encode(destBridge),
            data: payload,
            tokenAmounts: new Client.EVMTokenAmount[](0),
            feeToken: address(linkToken),
            extraArgs: Client._argsToBytes(
                Client.EVMExtraArgsV1({gasLimit: gasLimitForMsg})
            )
        });
    }

    function _getBridgeFee(
        uint64 destChainSelector,
        bytes memory payload,
        uint256 gasLimitForMsg
    ) internal view returns (uint256) {
        Client.EVM2AnyMessage memory ccipMessage = _buildCcipMessage(
            trustedBridges[destChainSelector],
            payload,
            gasLimitForMsg
        );
        return IRouterClient(getRouter()).getFee(destChainSelector, ccipMessage);
    }

    function withdrawLINK(address to) external onlyOwner {
        linkToken.safeTransfer(to, linkToken.balanceOf(address(this)));
    }

    function withdrawETH() external onlyOwner {
        (bool ok,) = owner().call{value: address(this).balance}("");
        require(ok, "ETH withdraw failed");
    }

    receive() external payable {}
}
