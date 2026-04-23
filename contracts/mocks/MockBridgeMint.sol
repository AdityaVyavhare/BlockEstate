// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../PropertyNFT.sol";

/// @dev Test-only helper: acts as `bridgeContract` to mint wrapped NFTs without CCIP.
contract MockBridgeMint {
    PropertyNFT public immutable nft;

    constructor(address _nft) {
        nft = PropertyNFT(_nft);
    }

    function mintWrapped(
        address to,
        string calldata tokenUri_,
        uint64 sourceChainSelector,
        address sourceContract,
        uint256 sourceTokenId
    ) external returns (uint256) {
        return nft.mintWrapped(to, tokenUri_, sourceChainSelector, sourceContract, sourceTokenId);
    }
}
