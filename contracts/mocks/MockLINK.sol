// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test double for Chainlink LINK (CCIP fee token) in Hardhat tests.
contract MockLINK is ERC20 {
    constructor() ERC20("Chainlink Token", "LINK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
