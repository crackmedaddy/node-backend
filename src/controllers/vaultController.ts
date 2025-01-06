// src/controllers/vaultController.ts
// noinspection TypeScriptValidateTypes

import {Request, Response} from 'express';
import {ethers} from 'ethers';
import AWS from 'aws-sdk';
import {
    distributeFunds,
    getContractBalanceWithUsd,
    getExpirationTime,
    unlockVault
} from '../services/blockchainService';

const CRACKED_CONVERSATIONS_TABLE = 'WinningConversations';

// --- NEW: Provide guaranteed string defaults if env vars are missing.
const dynamodb = new AWS.DynamoDB.DocumentClient({  region: process.env.AWS_REGION });

/**
 * Stores a record indicating that a conversation has successfully cracked a challenge.
 *
 * This function takes the provided `challenge_id` and `conversation_id` and writes a record
 * to the `CRACKED_CONVERSATIONS_TABLE` in DynamoDB with the current timestamp (`cracked_date`).
 * If an error occurs during the write operation, it is logged to the console.
 *
 * @async
 * @function storeCrackedConversation
 * @param {string} challenge_id - The unique identifier for the challenge that was cracked.
 * @param {string} conversation_id - The unique identifier of the conversation that cracked the challenge.
 * @returns {Promise<void>} A promise that resolves when the record has been written to DynamoDB.
 */
async function storeCrackedConversation(challenge_id: string, conversation_id: string): Promise<void> {
    try {
        const params: AWS.DynamoDB.DocumentClient.PutItemInput = {
            TableName: CRACKED_CONVERSATIONS_TABLE,
            Item: {
                challenge_id,
                conversation_id,
                cracked_date: new Date().toISOString(),
            },
        };
        await dynamodb.put(params).promise();
        console.log('Saved cracked conversation to DynamoDB:', challenge_id, conversation_id);
    } catch (err) {
        console.error('Error storing cracked conversation:', err);
    }
}

/**
 * Fetches the most recent messages by a given participant ID.
 *
 * This function queries the "Messages" table using the participant_id as the key.
 * It returns up to 50 of the most recent message contents in descending order of creation date.
 *
 * @async
 * @function getLastMessagesByParticipantId
 * @param {string} participantId - The unique identifier of the participant whose messages should be retrieved.
 * @returns {Promise<string[]>} A promise that resolves to an array of message contents.
 */
async function getLastMessagesByParticipantId(participantId: string): Promise<string[]> {
    try {
        const params: AWS.DynamoDB.DocumentClient.QueryInput = {
            TableName: "Messages",
            IndexName: "participant_id_created_date_index",
            KeyConditionExpression: 'participant_id = :g',
            ExpressionAttributeValues: {
                ':g': participantId,
            },
            ScanIndexForward: false, // Descending
            Limit: 50,               // Up to 10 items
        };

        // noinspection TypeScriptValidateTypes
        const result = await dynamodb.query(params).promise();
        if (!result.Items || result.Items.length === 0) {
            return [];
        }

        // We assume each item has a 'content' field containing the message text.
        const messages = result.Items.map((item) => (item as any).content || '');
        return messages;
    } catch (err) {
        console.error('Error fetching last 10 messages by participant_id:', err);
        return [];
    }
}

/**
 * Updates the status and vault balance of a given challenge in the "Challenges" table.
 *
 * This function updates the 'status' and 'vault_balance' fields in DynamoDB for
 * the provided challenge. If the update fails, it will throw an error.
 *
 * @async
 * @function updateChallengeStatusAndBalance
 * @param {string} challengeId - The unique identifier of the challenge to update.
 * @param {string} vaultBalance - The new vault balance to be stored in the table.
 * @param {string} status - The new status to be set on the challenge (e.g., "UNLOCKED", "EXPIRED").
 * @throws Will throw an error if the update operation fails.
 * @returns {Promise<void>} A promise that resolves when the challenge status and balance have been updated.
 */
async function updateChallengeStatusAndBalance(challengeId: string, vaultBalance: string, status: string) {
    const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
        TableName: "Challenges",
        Key: { id: challengeId }, // adjust key field if your Challenge table uses a different PK name
        UpdateExpression: 'SET #status = :status, #vault_balance = :balance',
        ExpressionAttributeNames: {
            '#status': 'status',
            '#vault_balance': 'vault_balance',
        },
        ExpressionAttributeValues: {
            ':status': status,
            ':balance': vaultBalance,
        }
    };

    try {
        await dynamodb.update(params).promise();
    } catch (err) {
        console.error('Error updating challenge status and vault balance:', err);
        throw err;
    }
}

/**
 * Retrieves the vault password for a given challenge from DynamoDB.
 *
 * This function queries the "VaultPasswords" table using the challenge_id as the key.
 * If a matching record is found, it returns the password; otherwise, it returns null.
 *
 * @async
 * @function getVaultPassword
 * @param {string} challenge_id - The unique identifier of the challenge whose vault password is needed.
 * @returns {Promise<string | null>} A promise that resolves to the vault password, or null if none is found.
 */
async function getVaultPassword(challenge_id: string): Promise<string | null> {
    try {
        // Construct a GetItemInput with guaranteed string TableName
        // and a computed key name that TS knows is a string.
        const params: AWS.DynamoDB.DocumentClient.GetItemInput = {
            TableName: "VaultPasswords",
            Key: {
                'challenge_id': challenge_id
            }
        };
        console.log('challenge_id', challenge_id);
        // noinspection TypeScriptValidateTypes
        const result = await dynamodb.get(params).promise();
        console.log('vault pass', result)
        if (result.Item && result.Item.password) {
            return result.Item.password;
        }
        return null;
    } catch (err) {
        console.error('Error fetching vault password:', err);
        return null;
    }
}

/**
 * Handles the unlock vault request.
 */
export const handleUnlockVault = async (req: Request, res: Response): Promise<void> => {
    const { user_address, participant_id, challenge_id, password, conversation_id } = req.body;
    // Validate the presence of a password in the request
    if (!password) {
        res.status(400).json({ error: 'Missing password.' });
        return;
    }

    // Validate userAddress
    if (!user_address || !ethers.utils.isAddress(user_address)) {
        res.status(400).json({ error: 'Invalid or missing userAddress.' });
        return;
    }

    try {
        // 1) Retrieve the vault password from the VaultPasswords table
        const currentVaultPassword = await getVaultPassword(challenge_id);
        if (!currentVaultPassword) {
            res.status(500).json({ error: 'Vault password not configured.' });
            return;
        }

        // 2) Check that the incoming request password matches the one in the database
        if (password !== currentVaultPassword) {
            console.error(`Provided password [${password}] does not match the stored password [${currentVaultPassword}].`);
            res.status(403).json({ error: 'Invalid password. The vault cannot be unlocked.' });
            return;
        }

        // 3) Retrieve the last message from the user (by participants_id)
        const {balanceUsd} = await getContractBalanceWithUsd(challenge_id);
        if (parseFloat(balanceUsd as string) <= 0.0) {
            res.status(403).json({ error: 'Vault is empty!' });
            return;
        }

        // 4) Retrieve the last message from the user (by participants_id)
        const lastMessages = await getLastMessagesByParticipantId(participant_id);
        if (lastMessages.length === 0) {
            console.log(`No recent messages found for this user.`);
            res.status(403).json({ error: 'User is not eligible to unlock the vault.' });
            return;
        }

        // 4) Check if the last message *includes* the vault password
        const foundPassword = lastMessages.some((msg) => msg.includes(currentVaultPassword));
        if (!foundPassword) {
            console.log(`None of the last 10 messages contain the vault password.`);
            res.status(403).json({ error: 'User is not eligible to unlock the vault.' });
            return;
        }

        // 5) Get the current vault balance BEFORE unlocking (so we capture the original balance)
        console.log(`balanceUsd for ${challenge_id} right before unlocking: ${balanceUsd}`)
        // For updating the table, you could store just the `balanceEth` or both.
        // Below, we'll pass `balanceEth` into DynamoDB.
        // If you want to store a float or a BigNumber, adjust accordingly.

        // 6) Update the challenge's status and vault_balance in the Challenges table
        await updateChallengeStatusAndBalance(challenge_id, balanceUsd, 'UNLOCKED');

        // 7) Now unlock the vault on-chain
        console.log(`Unlocking vault.....`);
        const tx = await unlockVault(challenge_id as string, user_address as string);

        // Store the cracked conversation in DynamoDB
        if (conversation_id) {
            await storeCrackedConversation(challenge_id, conversation_id);
        } else {
            console.warn('No conversation_id provided. Skipping cracked conversation storage.');
        }

        // Respond with transaction details
        res.status(200).json({
            message: 'Vault unlocked successfully.',
            transactionHash: tx.hash,
        });

    } catch (error) {
        console.error('Error unlocking vault:', error);
        res.status(500).json({ error: 'Failed to unlock the vault.' });
    }
};

/**
 * Controller to get the contract's balance.
 */
export const handleGetContractBalance = async (req: Request, res: Response): Promise<void> => {
    try {
        // Grab `challenge_id` from the query string
        const { challenge_id } = req.query;

        const { balanceEth, balanceUsd } = await getContractBalanceWithUsd(challenge_id as string);
        res.status(200).json({
            balance_eth: balanceEth,
            balance_usd: balanceUsd,
        });
    } catch (error) {
        console.error('Error fetching contract balance:', error);
        res.status(500).json({ error: 'Failed to fetch contract balance' });
    }
};

/**
 * Controller to distribute the funds.
 */
export const handleDistributeFunds = async (req: Request, res: Response): Promise<void> => {
    try {
        // If you need any inputs from req.body or req.query, retrieve them here.
        // For example, if you wanted to pass a `challenge_id` or something else.
        // But in a minimal example, we just call the contract.
        const { challenge_id } = req.query;

        // 1) Get the current vault balance BEFORE unlocking (so we capture the original balance)
        const { balanceUsd } = await getContractBalanceWithUsd(challenge_id as string);
        // For updating the table, you could store just the `balanceEth` or both.
        // Below, we'll pass `balanceEth` into DynamoDB.
        // If you want to store a float or a BigNumber, adjust accordingly.

        // 2) Update the challenge's status and vault_balance in the Challenges table
        await updateChallengeStatusAndBalance(challenge_id as string, balanceUsd as string, 'EXPIRED');

        // 3) Finally, distribute the funds to all participants equally
        const tx = await distributeFunds(challenge_id as string);

        res.status(200).json({
            message: 'Funds distributed successfully',
            transactionHash: tx.hash,
        });
    } catch (error) {
        console.error('Error distributing funds:', error);
        res.status(500).json({ error: 'Failed to distribute funds.' });
    }
};


/**
 * Controller to get the challenge's expiration time from the smart contract.
 */
export const handleGetExpirationTime = async (req: Request, res: Response): Promise<void> => {
    try {
        const { challenge_id } = req.query;

        const expirationDate = await getExpirationTime(challenge_id as string);
        // If you’d prefer returning a string, for example in ISO format:
        const expirationString = expirationDate.toISOString();

        res.status(200).json({
            expiration: expirationString,
        });
    } catch (error) {
        console.error('Error getting expiration time:', error);
        res.status(500).json({ error: 'Failed to retrieve expiration time.' });
    }
};
