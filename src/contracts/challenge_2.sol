// SPDX-License-Identifier: GPL-3.0

pragma solidity >=0.8.2 <0.9.0;

/**
 * @title CDAIVaultKeeper
 * @dev A vault contract that allows players to pay fees with a 70/30 split (vault/developer).
 *      - Tracks how much each participant has contributed to the vault.
 *      - Has an expiration date after which the entire vault is distributed proportionally based on
 *        each participant’s contribution.
 *      - The owner can still withdraw or unlock at any time (but if the distribute function is called
 *        after expiration, participants get their share first).
 *      - Also allows direct deposits to the vault without paying developer fees.
 */
contract CDAIVaultKeeper {
    // State Variables
    address public owner;
    address public developer;

    // Tracks whether a given participant has ever paid fees
    mapping(address => bool) public hasPaidFees;

    // Tracks how much of the vault (the 70% portion) each participant contributed
    mapping(address => uint256) public vaultContributions;

    // List of all unique fee-paying participants
    address[] public participants;

    // Expiration time (in UNIX timestamp) for the round
    uint256 public expirationTime;

    // Prevents repeated distributions
    bool public isDistributed;

    // Reentrancy Guard
    bool private locked;

    // Events
    event VaultUnlocked(address indexed recipient, uint256 amount);
    event FeesPaid(address indexed sender, uint256 totalAmount, uint256 vaultAmount, uint256 developerAmount);
    event FundsWithdrawn(address indexed owner, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DeveloperAddressUpdated(address indexed previousDeveloper, address indexed newDeveloper);
    event FundsDistributed(uint256 totalDistributed, uint256 numberOfParticipants);

    // Additional event for direct deposits
    event FundsDeposited(address indexed sender, uint256 amount);

    // Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "Reentrant call detected!");
        locked = true;
        _;
        locked = false;
    }

    /**
     * @dev Constructor sets the deployer as the initial owner and sets the developer address.
     * @param _developer The Ethereum address of the developer.
     * @param _roundDurationInSeconds The duration (in seconds) for the round before expiration.
     */
    constructor(address _developer, uint256 _roundDurationInSeconds) {
        require(_developer != address(0), "Developer address cannot be zero");
        owner = msg.sender;
        developer = _developer;
        emit OwnershipTransferred(address(0), owner);
        emit DeveloperAddressUpdated(address(0), developer);

        // Set the expiration time (e.g. 7 days = 604800 seconds, etc.)
        expirationTime = block.timestamp + _roundDurationInSeconds;
    }

    /**
     * @dev Transfers ownership to a new address.
     * @param newOwner The address of the new owner.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid new owner address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @dev Updates the developer address.
     * @param _newDeveloper The new developer's Ethereum address.
     */
    function updateDeveloperAddress(address _newDeveloper) external onlyOwner {
        require(_newDeveloper != address(0), "Developer address cannot be zero");
        emit DeveloperAddressUpdated(developer, _newDeveloper);
        developer = _newDeveloper;
    }

    /**
     * @dev Allows anyone to pay fees in Ether. The fees are split 70% to the vault (this contract)
     *      and 30% to the developer. These fees grant the user access to play the game.
     *      The 70% portion is recorded in `vaultContributions`.
     * Emits a {FeesPaid} event.
     */
    function payFees() public payable nonReentrant {
        require(msg.value > 0, "Must pay a positive amount of Ether as fees");
        require(!isRoundExpired(), "Round has expired; no more fees accepted");

        // Calculate split
        uint256 vaultAmount = (msg.value * 70) / 100; // 70%
        uint256 developerAmount = msg.value - vaultAmount; // 30%

        // Transfer 30% to the developer
        (bool successDev, ) = payable(developer).call{value: developerAmount}("");
        require(successDev, "Transfer to developer failed");

        // Record participant's vault contribution
        vaultContributions[msg.sender] += vaultAmount;

        // Record participant if first time paying
        if (!hasPaidFees[msg.sender]) {
            hasPaidFees[msg.sender] = true;
            participants.push(msg.sender);
        }

        emit FeesPaid(msg.sender, msg.value, vaultAmount, developerAmount);
    }

    /**
     * @dev Deposit funds directly into the vault without paying developer fees.
     *      This can be used by anyone to boost the vault’s balance.
     * Emits a {FundsDeposited} event.
     */
    function depositFunds() external payable nonReentrant {
        require(msg.value > 0, "Must deposit a positive amount of Ether");
        
        // Since no developer fee is taken, 100% of msg.value remains in the contract.
        emit FundsDeposited(msg.sender, msg.value);
    }

    /**
     * @dev Allows the owner to withdraw a specific amount of Ether from the vault.
     * @param _amount The amount of Ether to withdraw (in wei).
     * Emits a {FundsWithdrawn} event.
     */
    function withdraw(uint256 _amount) external onlyOwner nonReentrant {
        require(_amount <= address(this).balance, "Insufficient funds in the vault");

        (bool success, ) = payable(owner).call{value: _amount}("");
        require(success, "Withdrawal failed");
        emit FundsWithdrawn(owner, _amount);
    }

    /**
     * @dev Allows the owner to unlock the vault and transfer the entire balance to a recipient.
     *      This bypasses the proportional distribution logic, so it's recommended to only call this
     *      *before* the round expires—or understand that participants may not get their share if this
     *      is used incorrectly.
     * @param recipient The address to receive the funds.
     * Emits a {VaultUnlocked} event.
     */
    function unlockVault(address recipient) external onlyOwner nonReentrant {
        require(recipient != address(0), "Invalid recipient address");
        uint256 balance = address(this).balance;
        require(balance > 0, "No funds to unlock");

        (bool success, ) = payable(recipient).call{value: balance}("");
        require(success, "Ether transfer failed");

        emit VaultUnlocked(recipient, balance);
    }

    /**
     * @dev Distributes all current vault funds to participants in proportion to their vault contributions,
     *      *only if* expiration time is reached. Can only be called once.
     *      Leftover wei from integer division remains in the contract.
     */
    function distributeFunds() external nonReentrant {
        require(isRoundExpired(), "Round not yet expired");
        require(!isDistributed, "Funds already distributed");
        require(participants.length > 0, "No participants in this round");

        uint256 totalFunds = address(this).balance;

        // 1. Calculate total contributions from all participants
        uint256 totalContributions;
        for (uint256 i = 0; i < participants.length; i++) {
            totalContributions += vaultContributions[participants[i]];
        }
        require(totalContributions > 0, "No vault contributions recorded");

        // 2. Distribute proportionally based on each participant's contribution
        for (uint256 i = 0; i < participants.length; i++) {
            address participant = participants[i];
            uint256 contribution = vaultContributions[participant];

            if (contribution > 0) {
                // Participant’s share = (totalFunds * participant's vault contribution) / totalContributions
                uint256 participantShare = (totalFunds * contribution) / totalContributions;
                
                (bool success, ) = payable(participant).call{value: participantShare}("");
                require(success, "Transfer to participant failed");
            }
        }

        // Mark as distributed so it can't be called again
        isDistributed = true;
        emit FundsDistributed(totalFunds, participants.length);
    }

    /**
     * @dev Returns whether the round is expired.
     */
    function isRoundExpired() public view returns (bool) {
        return block.timestamp >= expirationTime;
    }

    /**
     * @dev Fallback function to accept Ether via `payFees` or direct transfers.
     *      Delegates to the payFees function to ensure the 70/30 split.
     */
    receive() external payable {
        payFees();
    }

    /**
     * @dev Disallow direct fallback transfers.
     */
    fallback() external payable {
        revert("Direct payments not allowed. Use payFees or depositFunds function.");
    }
}
