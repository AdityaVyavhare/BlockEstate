// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BRTToken
 * @notice ERC20 utility token for the Real Estate NFT Marketplace.
 *
 * Use cases:
 *  - Buying properties on the marketplace
 *  - Validator rewards
 *  - Platform fees
 *  - Cross-chain bridge payments
 */
contract BRTToken is ERC20, Ownable {
    /// @notice Addresses authorized to mint/burn (bridge contracts)
    mapping(address => bool) public bridges;

    event BridgeUpdated(address indexed bridge, bool enabled);

    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        // Mint initial supply to deployer (1 million tokens)
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    modifier onlyBridgeOrOwner() {
        require(bridges[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }

    /// @notice Owner can authorize bridge contracts to mint/burn
    function setBridge(address bridge, bool enabled) external onlyOwner {
        bridges[bridge] = enabled;
        emit BridgeUpdated(bridge, enabled);
    }

    /// @notice Mint tokens — callable by owner or bridge
    function mint(address to, uint256 amount) external onlyBridgeOrOwner {
        _mint(to, amount);
    }

    /// @notice Burn tokens from an address — callable by owner or bridge
    function burn(address from, uint256 amount) external onlyBridgeOrOwner {
        _burn(from, amount);
    }
}
