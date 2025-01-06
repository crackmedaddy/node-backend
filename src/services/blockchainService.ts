// src/services/blockchainService.ts

import {ethers} from 'ethers';
import AWS from 'aws-sdk';
import axios from 'axios';

const {
    INFURA_PROJECT_ID,
    INFURA_PROJECT_SECRET,
    BACKEND_PRIVATE_KEY,
    CHALLENGE_SMART_CONTRACTS_TABLE, // e.g. "ChallengeSmartContracts"
} = process.env;


if (!INFURA_PROJECT_SECRET || !BACKEND_PRIVATE_KEY) {
    throw new Error('Missing required environment variables.');
}
/**
 * Decide which provider URL and network config to use
 * based on whether we are in “production” or “development”.
 */
const isProduction = (process.env.NODE_ENV === 'production');
console.log('process.env.NODE_ENV', process.env.NODE_ENV)

const networkConfig = isProduction
    ? {
        name: "base",
        chainId: 8453,
        providerUrl: `https://base-mainnet.infura.io/v3/${INFURA_PROJECT_ID}`
    }
    : {
        name: "base-sepolia",
        chainId: 84532,
        providerUrl: 'https://sepolia.base.org',
    };

const provider = new ethers.providers.StaticJsonRpcProvider(
    networkConfig.providerUrl,
    {
        chainId: networkConfig.chainId,
        name: networkConfig.name
    }
);

const wallet = new ethers.Wallet(BACKEND_PRIVATE_KEY, provider);

// -------------------------------------
// 2. DynamoDB client initialization
//    We'll read the "ChallengeSmartContracts" table for the address + ABI
const TABLE_NAME = 'ETHPrice';
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION });


// -------------------------------------
// 3. Cache structure: challengeId -> { contract, lastUsed: number }
//
//    We’ll store up to 3 challenges at once, using a simple LRU eviction policy
const MAX_CONTRACTS = 3;
type CachedContractInfo = {
    contract: ethers.Contract;
    lastUsed: number;
};

const contractCache: Record<string, CachedContractInfo> = {};

/**
 * Helper to remove the least-recently-used contract from our cache
 * when we exceed MAX_CONTRACTS.
 */
function evictOldestContract() {
    let oldestChallenge: string | null = null;
    let oldestTimestamp = Infinity;

    // Find the challenge with the smallest `lastUsed` value
    for (const challengeId in contractCache) {
        if (contractCache[challengeId].lastUsed < oldestTimestamp) {
            oldestTimestamp = contractCache[challengeId].lastUsed;
            oldestChallenge = challengeId;
        }
    }

    // Evict it from the cache
    if (oldestChallenge) {
        delete contractCache[oldestChallenge];
        console.log(`Evicted contract for challenge_id=${oldestChallenge} from cache.`);
    }
}

/**
 * Fetches (or reuses) a Contract instance for the given `challengeId`.
 *
 * 1) Checks an in-memory LRU cache for an existing contract.
 * 2) If not found, loads the contract data (address, ABI) from DynamoDB (ChallengeSmartContracts table).
 * 3) If the cache is full, evicts the least-recently-used contract entry.
 *
 * @async
 * @function getContractForChallenge
 * @param {string} challengeId - The unique identifier for the challenge whose contract is needed.
 * @returns {Promise<ethers.Contract>} A Promise that resolves to an Ethers.js Contract instance.
 * @throws Will throw an error if the contract data is missing or invalid in DynamoDB.
 */
async function getContractForChallenge(challengeId: string): Promise<ethers.Contract> {
    // 1) If contract is already in the cache, update `lastUsed` and return it
    if (contractCache[challengeId]) {
        contractCache[challengeId].lastUsed = Date.now();
        return contractCache[challengeId].contract;
    }

    // 2) If not cached, fetch from DynamoDB
    const params: AWS.DynamoDB.DocumentClient.GetItemInput = {
        TableName: CHALLENGE_SMART_CONTRACTS_TABLE ?? 'ChallengeSmartContracts',
        Key: {
            challenge_id: challengeId,
        },
    };
    const result = await dynamodb.get(params).promise();
    console.log('result', result)
    if (!result.Item) {
        throw new Error(`No contract data found for challenge_id=${challengeId}`);
    }

    const contractAddress = result.Item.contract_address;
    if (!ethers.utils.isAddress(contractAddress)) {
        throw new Error(`Invalid contract address in ChallengeSmartContracts table: ${contractAddress}`);
    }

    let contractAbi: any;
    if (result.Item.contract_abi) {
        // If the ABI is stored as JSON string, parse it
        contractAbi = JSON.parse(result.Item.contract_abi);
    } else {
        throw new Error(`No ABI found for challenge_id=${challengeId}`);
    }

    // 3) Create the contract
    const newContract = new ethers.Contract(contractAddress, contractAbi, wallet);

    // 4) If we’ve reached the max # of contracts in the cache, evict the oldest
    if (Object.keys(contractCache).length >= MAX_CONTRACTS) {
        evictOldestContract();
    }

    // 5) Store in cache and return
    contractCache[challengeId] = {
        contract: newContract,
        lastUsed: Date.now(),
    };
    console.log(`Initialized contract for challenge_id=${challengeId}.`);
    return newContract;
}

/**
 * Calls the contract's `unlockVault` method on-chain to unlock the vault for the given user address.
 *
 * @async
 * @function unlockVault
 * @param {string} challengeId - The unique identifier of the challenge whose vault is being unlocked.
 * @param {string} userAddress - The Ethereum address that is authorized to unlock the vault.
 * @returns {Promise<ethers.providers.TransactionResponse>} A promise that resolves to the transaction response.
 * @throws Will throw an error if the transaction fails or the contract call reverts.
 */
export async function unlockVault(challengeId: string, userAddress: string) {
    const contract = await getContractForChallenge(challengeId);
    console.log(`unlockVault contract: ${JSON.stringify(contract)}`);
    console.log('providerUrl', networkConfig.providerUrl)
    try {
        const tx = await contract.unlockVault(userAddress);
        console.log(`Transaction sent: ${tx.hash}`);
        await tx.wait();
        console.log(`Transaction confirmed: ${tx.hash}`);
        return tx;
    } catch (error) {
        console.error('Error in unlockVault:', error);
        throw error;
    }
}

/**
 * Retrieves the current ETH balance of the specified challenge's contract.
 *
 * @async
 * @function getContractBalance
 * @param {string} challengeId - The unique identifier of the challenge.
 * @returns {Promise<string>} A promise that resolves to the contract's balance (in ETH) as a string.
 * @throws Will throw an error if the contract call or balance retrieval fails.
 */
export async function getContractBalance(challengeId: string): Promise<string> {
    const contract = await getContractForChallenge(challengeId);
    try {
        // The simpler approach: just get the current contract’s ETH balance
        // If your contract might have a custom function like getBalance(), call that
        const balanceWei = await provider.getBalance(contract.address);
        return ethers.utils.formatEther(balanceWei);
    } catch (error) {
        console.error('Error in getContractBalance:', error);
        throw error;
    }
}

/**
 * Invokes the `distributeFunds` method on the contract to distribute the funds among participants.
 *
 * @async
 * @function distributeFunds
 * @param {string} challengeId - The unique identifier of the challenge.
 * @returns {Promise<ethers.providers.TransactionResponse>} A promise that resolves to the transaction response.
 * @throws Will throw an error if the transaction fails or the contract call reverts.
 */
export async function distributeFunds(challengeId: string) {
    const contract = await getContractForChallenge(challengeId);
    try {
        const tx = await contract.distributeFunds();
        // Optionally: await tx.wait();
        return tx;
    } catch (error) {
        console.error('Error in distributeFunds:', error);
        throw error;
    }
}

/**
 * A helper function that returns a combined ETH and USD balance,
 * pulling the latest ETH price from somewhere (e.g., DynamoDB + CoinGecko).
 *
 * @async
 * @function getContractBalanceWithUsd
 * @param {string} challengeId - The unique identifier of the challenge.
 * @returns {Promise<{ balanceEth: string, balanceUsd: string }>} An object with `balanceEth` and `balanceUsd`.
 */
export async function getExpirationTime(challengeId: string) {
    const contract = await getContractForChallenge(challengeId);
    console.log('contract', contract)
    try {
        const expirationBigNum = await contract.expirationTime();
        const expirationSec = expirationBigNum.toNumber();
        return new Date(expirationSec * 1000);
    } catch (error) {
        console.error('Error in getExpirationTime:', error);
        throw error;
    }
}

/**
 * Fetch or retrieve ETH→USD price with a DynamoDB cache.
 * This function:
 *  1) Checks if "ETH" price in DB is younger than 10 mins
 *  2) If it's too old or doesn't exist, calls the API, updates DB
 *  3) Returns the (possibly cached) ETH→USD price
 *
 * @async
 * @function getEthUsdPrice
 * @returns {Promise<number>} A promise that resolves to the ETH→USD price as a number.
 * @throws Will throw an error if fetching or storing the price fails.
 */
export async function getContractBalanceWithUsd(challengeId: string): Promise<{ balanceEth: string, balanceUsd: string }> {
    const balanceEth = await getContractBalance(challengeId);
    console.log('balanceEth', balanceEth);
    const ethPriceUsd = await getEthUsdPrice(); // your existing logic to retrieve price
    console.log('ethPriceUsd', ethPriceUsd)
    const balanceUsd = (parseFloat(balanceEth) * ethPriceUsd).toFixed(2);
    return {
        balanceEth,
        balanceUsd,
    };
}

/**
 * Fetch or retrieve ETH→USD price with a DynamoDB cache.
 * This function:
 *  1) Checks if "ETH" price in DB is younger than 10 mins
 *  2) If it's too old or doesn't exist, calls the API, updates DB
 *  3) Returns the (possibly cached) ETH→USD price
 */
export async function getEthUsdPrice(): Promise<number> {
    // noinspection TypeScriptValidateTypes
    try {
        const params: AWS.DynamoDB.DocumentClient.GetItemInput = {
            TableName: TABLE_NAME,
            Key: { pk: 'ETH' },
        };

        // 1. Attempt to get the cached item from DynamoDB
        // noinspection TypeScriptValidateTypes
        const result = await dynamodb.get(params).promise();

        if (result.Item) {
            const cachedPrice = parseFloat(result.Item.price_usd);
            const lastUpdatedAt = parseInt(result.Item.last_updated, 10);

            // Check if the data is older than 10 minutes (600,000 ms)
            const now = Date.now();
            if (now - lastUpdatedAt < 600_000) {
                // The cached value is still fresh — return it
                return cachedPrice;
            }
        }

        // 2. If no item or it's too old, fetch a fresh price from CoinGecko
        const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
        const { data } = await axios.get(url);
        // noinspection TypeScriptUnresolvedReference
        const freshPrice = data.ethereum.usd; // e.g. 1234.56

        // 3. Update DynamoDB with the fresh price
        const putParams: AWS.DynamoDB.DocumentClient.PutItemInput = {
            TableName: TABLE_NAME,
            Item: {
                pk: 'ETH',
                price_usd: freshPrice,
                last_updated: Date.now().toString(),
            },
        };
        await dynamodb.put(putParams).promise();

        // 4. Return the fresh price
        return freshPrice;
    } catch (error) {
        console.error('Error fetching or storing ETH price:', error);
        throw new Error('Failed to fetch ETH→USD price.');
    }
}