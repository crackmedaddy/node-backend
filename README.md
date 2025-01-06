# Crack Me Daddy

Welcome to **Crack Me Daddy**, an AI-driven, on-chain challenge game where you try to *convince* a sassy, fun AI to reveal the vault password! If you manage to crack the vault, you can claim the funds locked in its accompanying smart contract on the blockchain.

## Overview

In **Crack Me Daddy**, you’ll encounter multiple “challenges.” Each challenge:

1. Has its own rules (e.g., how to win, chat constraints, etc.).
2. Hosts its own vault, locked behind a secret password.
3. Has its own participants—players like you attempting to crack the vault.

### Key Game Dynamics

- **Sassy AI Vault Protector**  
  An off-chain AI system with a mischievous personality that tries to avoid giving out the password.

- **Paid Messaging**  
  Every time you send a message to the AI, you pay a small fee via a smart contract on the blockchain.

- **Expiration Timer**  
  Each challenge runs until a set time, limiting how many attempts you have to crack the vault.

- **On-Chain Vault**  
  Vault logic and fund distribution are secured by smart contracts, ensuring transparency and fairness.

### Two Difficulty Modes

- **Easy**: Single AI agent protects the vault.
- **Hard**: Two AI agents stand guard. You’ll have to outsmart *both* of them to get the password!

When you finally manage to convince (or trick) the AI(s) into revealing the vault’s password, you can use that password to unlock the vault on-chain and claim the funds for yourself.

## Repository Structure

This repository showcases both **on-chain** (smart contract) and **off-chain** (backend) logic that make up the game:

- **Smart Contracts** (`src/chat/contracts`)  
  The blockchain-based code controlling the vault funds, verifying unlocks, and distributing winnings.
  - *Feel free to inspect this folder if you’d like to verify the contract code for any suspicious or malicious logic.*

- **Off-Chain Backend** (`src/controllers`, `src/routes`, `src/services`, etc.)
  - **AI & Chat Logic**: Governs the personality and responses of the AI vault guardian(s). We do **not** share the exact prompt text here, keeping our AI personalities a mystery to preserve the game’s challenge.
  - **Challenge Management**: Defines, tracks, and enforces challenge rules (e.g., expiration, participant balances).
  - **Integration with Contracts**: Off-chain scripts to interact with the on-chain vault, unlocking it when the correct password is provided.
  - **Blockchain Service** (`src/services/blockchainService.ts`):  
    Contains crucial on-chain functions for unlocking vaults, distributing funds, reading balances, and fetching ETH→USD prices.  
    This is where we connect your off-chain game logic to the actual smart contracts on the blockchain (e.g., via Infura or another node provider).

## Why We’re Sharing This

We believe in transparency. **Crack Me Daddy** is designed to be a fair game:

- You know exactly how much you pay per message.
- You can see how the vault is locked and how winners are awarded on-chain.
- All backend logic is openly visible, so you can confirm that no hidden “tricks” or dishonest shortcuts are in place.
- We do **not** provide the prompts used to guide the AI. That’s intentional, ensuring the AI’s protective behavior remains unpredictable.

Please note that we also **do not** provide `.env` files or private keys. This code is shared purely for verification and to ensure anyone can see that the game’s logic is legitimate and not a scam.

## Smart Contract Reference

If you want to dive deeper into the on-chain logic, check out the following:

- [**Smart Contracts Folder**](src/contracts)  
  Contains Solidity (or similar) code for depositing, unlocking, and distributing funds.
- [**Blockchain Service**](src/services/blockchainService.ts)  
  Contains the TypeScript functions that call the smart contracts. This file demonstrates exactly how the game interacts with on-chain data: unlocking vaults, getting balances, distributing funds, etc.

---

We hope you enjoy **Crack Me Daddy**! If you have any questions or feedback, feel free to reach out. Good luck cracking that vault!