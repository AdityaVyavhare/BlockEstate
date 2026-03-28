// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Verification
 * @notice Decentralized majority-voting validator system for property verification.
 *
 * Validators vote approve/reject on each property. When approvals exceed
 * the majority threshold (> validatorCount / 2), the property is automatically
 * marked as verified on the PropertyNFT contract.
 */

interface IPropertyNFT {
    function setVerified(uint256 tokenId, bool verified) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IRewardBRT {
    function mint(address to, uint256 amount) external;
}

contract Verification is Ownable {
    IPropertyNFT public propertyNFT;
    IRewardBRT public brtToken;

    // ── Validator Registry ──────────────────────────────────
    mapping(address => bool) public validators;
    uint256 public validatorCount;
    address[] private validatorAddresses;

    // ── User Registry (Buyer + Seller) ──────────────────────
    mapping(address => bool) public users;
    address[] private userAddresses;
    uint256 public initialUserMint = 1_000_000 * 1e18;
    uint256 public initialValidatorMint = 1_000_000 * 1e18;

    /// @notice Optional override for minimum approvals required.
    /// If 0, the contract uses the majority rule: floor(n/2)+1.
    uint256 public minApprovals;

    /// @notice BRT reward per correct vote (default 10 BRT)
    uint256 public rewardPerVote = 10 * 1e18;

    // ── Vote Tracking ───────────────────────────────────────
    struct VoteData {
        uint256 approvals;
        uint256 rejections;
        bool finalized;
        mapping(address => bool) hasVoted;
        address[] approvers;
        address[] rejecters;
    }

    mapping(uint256 => VoteData) private _votes;

    // ── Events ──────────────────────────────────────────────
    event ValidatorAdded(address indexed validator);
    event ValidatorRemoved(address indexed validator);
    event UserAdded(address indexed user);
    event UserRemoved(address indexed user);
    event Voted(
        uint256 indexed tokenId,
        address indexed validator,
        bool approve
    );
    event PropertyVerified(uint256 indexed tokenId, bool verified);
    event ValidatorRewarded(address indexed validator, uint256 amount, uint256 indexed tokenId);

    constructor(address _propertyNFT, address _brtToken) Ownable(msg.sender) {
        require(_propertyNFT != address(0), "Zero address");
        require(_brtToken != address(0), "Zero BRT address");
        propertyNFT = IPropertyNFT(_propertyNFT);
        brtToken = IRewardBRT(_brtToken);
    }

    // ── Modifiers ───────────────────────────────────────────

    modifier onlyValidator() {
        require(validators[msg.sender], "Not a validator");
        _;
    }

    // ── Validator Management ────────────────────────────────

    function addValidator(address validator) external onlyOwner {
        require(!validators[validator], "Already a validator");
        require(validator != address(0), "Zero address");
        validators[validator] = true;
        validatorCount++;
        validatorAddresses.push(validator);
        // Admin mints initial tokens for validator accounts.
        if (initialValidatorMint > 0) {
            brtToken.mint(validator, initialValidatorMint);
        }
        emit ValidatorAdded(validator);
    }

    /// @notice Admin can add a user (who can act as both buyer and seller).
    ///         Also mints initial BRT for testing convenience.
    function addUser(address user) external onlyOwner {
        require(user != address(0), "Zero address");
        require(!users[user], "Already a user");
        users[user] = true;
        userAddresses.push(user);
        if (initialUserMint > 0) {
            brtToken.mint(user, initialUserMint);
        }
        emit UserAdded(user);
    }

    function isUser(address user) external view returns (bool) {
        return users[user];
    }

    function removeUser(address user) external onlyOwner {
        require(users[user], "Not a user");
        users[user] = false;
        emit UserRemoved(user);
    }

    function getUserAddresses() external view returns (address[] memory) {
        return userAddresses;
    }

    function removeValidator(address validator) external onlyOwner {
        require(validators[validator], "Not a validator");
        validators[validator] = false;
        validatorCount--;
        emit ValidatorRemoved(validator);
    }

    function getValidatorAddresses() external view returns (address[] memory) {
        return validatorAddresses;
    }

    function isValidator(address validator) external view returns (bool) {
        return validators[validator];
    }

    // ── Voting ──────────────────────────────────────────────

    /// @notice Cast a vote on a property (approve or reject)
    /// @param tokenId The property token ID to vote on
    /// @param approve true = approve, false = reject
    function vote(uint256 tokenId, bool approve) external onlyValidator {
        // Ensure token exists
        require(propertyNFT.ownerOf(tokenId) != address(0), "Token does not exist");

        VoteData storage vd = _votes[tokenId];
        require(!vd.finalized, "Already finalized");
        require(!vd.hasVoted[msg.sender], "Already voted");

        vd.hasVoted[msg.sender] = true;

        if (approve) {
            vd.approvals++;
            vd.approvers.push(msg.sender);
        } else {
            vd.rejections++;
            vd.rejecters.push(msg.sender);
        }

        emit Voted(tokenId, msg.sender, approve);

        // Check if majority threshold reached
        _checkThreshold(tokenId);
    }

    // ── View Functions ──────────────────────────────────────

    /// @notice Get verification status for a property
    function getVerificationStatus(
        uint256 tokenId
    )
        external
        view
        returns (uint256 approvals, uint256 rejections, bool finalized)
    {
        VoteData storage vd = _votes[tokenId];
        return (vd.approvals, vd.rejections, vd.finalized);
    }

    /// @notice Check if a validator has voted on a property
    function hasVoted(
        uint256 tokenId,
        address validator
    ) external view returns (bool) {
        return _votes[tokenId].hasVoted[validator];
    }

    // ── Internal ────────────────────────────────────────────

    /// @notice Owner can update reward amount per correct vote
    function setRewardPerVote(uint256 _amount) external onlyOwner {
        rewardPerVote = _amount;
    }

    /// @notice Owner can override the minimum approvals required.
    /// @dev For majority-based validation by default, keep this as 0.
    function setMinApprovals(uint256 _minApprovals) external onlyOwner {
        if (_minApprovals == 0) {
            minApprovals = 0;
            return;
        }
        require(_minApprovals <= validatorCount, "Min too high");
        require(_minApprovals > 0, "Min must be > 0");
        minApprovals = _minApprovals;
    }

    function _checkThreshold(uint256 tokenId) internal {
        VoteData storage vd = _votes[tokenId];
        // Either configured threshold or default majority threshold.
        uint256 threshold = minApprovals > 0 ? minApprovals : (validatorCount / 2) + 1;

        if (vd.approvals >= threshold) {
            vd.finalized = true;
            propertyNFT.setVerified(tokenId, true);
            emit PropertyVerified(tokenId, true);
            // Reward validators who voted correctly (approved)
            _distributeRewards(vd.approvers, tokenId);
        } else if (vd.rejections >= threshold) {
            vd.finalized = true;
            propertyNFT.setVerified(tokenId, false);
            emit PropertyVerified(tokenId, false);
            // Reward validators who voted correctly (rejected)
            _distributeRewards(vd.rejecters, tokenId);
        }
    }

    /// @notice Distribute BRT rewards to validators who voted on the winning side
    function _distributeRewards(address[] storage winners, uint256 tokenId) internal {
        if (rewardPerVote == 0) return;
        for (uint256 i = 0; i < winners.length; i++) {
            brtToken.mint(winners[i], rewardPerVote);
            emit ValidatorRewarded(winners[i], rewardPerVote, tokenId);
        }
    }
}
