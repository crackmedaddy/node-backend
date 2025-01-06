// chatHandler.ts
// noinspection TypeScriptValidateTypes

import fs from 'fs';
import path from 'path';
import AWS from 'aws-sdk';
import {RequestHandler} from 'express';

import {openai} from '@ai-sdk/openai';
import {CoreTool, generateText, streamText, tool} from 'ai';
import {notifySlackChannel} from './slackNotifier';
import {getContractBalanceWithUsd} from '../services/blockchainService';

import {z} from 'zod';
import {v4 as uuidv4} from 'uuid'; // For generating message_id

// -------------- New constants for your tables --------------
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION });
const MESSAGES_TABLE = 'Messages';
const PARTICIPANTS_TABLE = 'Participants';
const CHALLENGES_TABLE = 'Challenges';

const VAULT_PASSWORDS_TABLE = 'VaultPasswords';

const VAULT_CRACKED_VIDEO_COMPONENT = "<div data-video=\"https://dev-medias-bucket.s3.us-east-1.amazonaws.com/unlocked_1.mp4\" width=\"854\" height=\"480\" </div>";

// Example GPT-4 cost structure
const GPT4O_PROMPT_PER_1K = 0.0025;
const GPT4O_COMPLETION_PER_1K = 0.01;
const GPT4O_MINI_PROMPT_PER_1K = 0.00015;
const GPT4O_MINI_COMPLETION_PER_1K = 0.0006;

type ChatMessage = {
    role: 'user' | 'assistant';
    content: string;
};

/**
 * Determines whether a participant is sending their first message in a given conversation.
 *
 * This function queries the MESSAGES_TABLE using the provided `conversation_id` in a GSI.
 * If no records are found for the specified conversation, it returns `true`, indicating that
 * this is the participant's first message in that conversation.
 *
 * @async
 * @function isFirstParticipantMessageInConversation
 * @param {string} conversation_id - The unique identifier for the conversation.
 * @returns {Promise<boolean>} - Resolves to `true` if no messages exist in this conversation, otherwise `false`.
 */
async function isFirstParticipantMessageInConversation(
    conversation_id: string
): Promise<boolean> {
    try {
        const params: AWS.DynamoDB.DocumentClient.QueryInput = {
            TableName: MESSAGES_TABLE,
            IndexName: 'conversation_id_index',
            // The KeyConditionExpression only uses conversation_id because
            // that’s the index’s partition key for this GSI.
            KeyConditionExpression: 'conversation_id = :convId',

            ExpressionAttributeValues: {
                ':convId': conversation_id,
            },

            // We only need to know if there is at least one existing message.
            Limit: 2,
        };

        const result = await dynamodb.query(params).promise();
        // If no items match, it means the participant has never sent a message in this conversation.
        return result.Count === 0;
    } catch (error) {
        console.error('Error in isFirstParticipantMessageInConversation:', error);
        // Return false so we don’t break other logic if something goes wrong.
        return false;
    }
}

/**
 * Increments the `participants_count` for a given challenge in the CHALLENGES_TABLE by 1.
 *
 * @async
 * @function incrementChallengeParticipants
 * @param {string} challenge_id - The unique identifier of the challenge.
 * @returns {Promise<void>} - A promise that resolves once the database update completes.
 */
async function incrementChallengeParticipants(challenge_id: string) {
    try {
        const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
            TableName: CHALLENGES_TABLE,
            Key: { id: challenge_id },
            UpdateExpression: 'ADD participants_count :inc',
            ExpressionAttributeValues: {
                ':inc': 1,
            },
            ReturnValues: 'UPDATED_NEW',
        };
        const response = await dynamodb.update(params).promise();
        console.log(
            'Updated participants_count:',
            response.Attributes?.participants_count
        );
    } catch (error) {
        console.error('Error incrementing challenge participants:', error);
    }
}

/**
 * Handles incoming user messages for a given challenge and participant, performing:
 *  - A check for first-time participant messages (incrementing challenge participants if so).
 *  - Saving the user's message to the DB.
 *  - Incrementing the challenge's message count.
 *  - Decrementing the participant's balance by one.
 *
 * @async
 * @function handleUserMessage
 * @param {string} challenge_id - The unique identifier for the challenge.
 * @param {string} conversation_id - The identifier for the current conversation.
 * @param {string} participant_id - The unique identifier for the participant.
 * @param {string} userMessage - The text of the user's message.
 * @returns {Promise<void>} - Resolves once all sub-operations (DB writes/updates) have completed.
 */
async function handleUserMessage(
    challenge_id: string,
    conversation_id: string,
    participant_id: string,
    userMessage: string
): Promise<void> {
    // A. Check if it’s the participant’s first message in the conversation
    const isFirst = await isFirstParticipantMessageInConversation(
        conversation_id
    );
    if (isFirst) {
        console.log('Participant is sending their first message in this conversation!');
        await incrementChallengeParticipants(challenge_id);
    } else {
        console.log('Participant has already sent a message in this conversation. Skipping increment.');
    }

    // B. Save the user’s message
    await saveMessageToDb({
        conversation_id: conversation_id || 'unknown_convo',
        challenge_id,
        participant_id,
        role: 'user',
        content: userMessage,
    });

    // C. Increment challenge message count
    await incrementChallengeMessageCount(challenge_id);

    // D. Decrement participant balance
    const newBalance = await decrementParticipantBalance(challenge_id, participant_id);
    console.log('New participant balance:', newBalance);
}

/**
 * Retrieves the current message balance for a participant in a specific challenge.
 * If the participant or balance attribute is not found, this function returns `null`.
 *
 * @async
 * @function getParticipantBalance
 * @param {string} challenge_id - The unique identifier of the challenge.
 * @param {string} participant_id - The unique identifier of the participant.
 * @returns {Promise<number | null>} - The current balance as a number, or `null` if not found.
 */
async function getParticipantBalance(
    challenge_id: string,
    participant_id: string
): Promise<number | null> {
    try {
        const params: AWS.DynamoDB.DocumentClient.GetItemInput = {
            TableName: PARTICIPANTS_TABLE,
            Key: {
                challenge_id,
                participant_id,
            },
        };
        const response = await dynamodb.get(params).promise();
        if (!response.Item || typeof response.Item.balance === 'undefined') {
            console.warn('Participant not found or balance attribute missing.');
            return null;
        }
        // Could be a string or number or AWS Dynamo Decimal
        return Number(response.Item.balance);
    } catch (error) {
        console.error('Error in getParticipantBalance:', error);
        return null;
    }
}

/**
 * Decrements the participant's message balance by 1 for a specific challenge/participant pair.
 *
 * @async
 * @function decrementParticipantBalance
 * @param {string} challenge_id - The unique identifier of the challenge.
 * @param {string} participant_id - The unique identifier of the participant.
 * @returns {Promise<number | null>} - The updated balance after decrement, or `null` if the update fails.
 */
async function decrementParticipantBalance(
    challenge_id: string,
    participant_id: string
): Promise<number | null> {
    try {
        const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
            TableName: PARTICIPANTS_TABLE,
            Key: {
                challenge_id,
                participant_id,
            },
            UpdateExpression: 'ADD balance :dec',
            ExpressionAttributeValues: {
                ':dec': -1,
            },
            ReturnValues: 'UPDATED_NEW',
        };
        const response = await dynamodb.update(params).promise();
        if (response.Attributes && response.Attributes.balance !== undefined) {
            return Number(response.Attributes.balance);
        }
        return null;
    } catch (error) {
        console.error('Error in decrementParticipantBalance:', error);
        return null;
    }
}

/**
 * Increments the `messages_count` field by 1 for a specific challenge.
 *
 * @async
 * @function incrementChallengeMessageCount
 * @param {string} challenge_id - The unique identifier of the challenge.
 * @returns {Promise<number | null>} - The updated `messages_count` value, or `null` if the update fails.
 */
async function incrementChallengeMessageCount(challenge_id: string): Promise<number | null> {
    try {
        const params: AWS.DynamoDB.DocumentClient.UpdateItemInput = {
            TableName: CHALLENGES_TABLE,
            Key: { id: challenge_id },
            UpdateExpression: 'ADD messages_count :inc',
            ExpressionAttributeValues: { ':inc': 1 },
            ReturnValues: 'UPDATED_NEW',
        };
        const response = await dynamodb.update(params).promise();
        if (!response.Attributes || typeof response.Attributes.messages_count === 'undefined') {
            return null;
        }
        return Number(response.Attributes.messages_count);
    } catch (error) {
        console.error('Error in incrementChallengeMessageCount:', error);
        return null;
    }
}

/**
 * Saves a single message to the MESSAGES_TABLE in DynamoDB.
 *
 * @async
 * @function saveMessageToDb
 * @param {Object} params - An object containing the necessary message fields.
 * @param {string} params.conversation_id - The conversation ID to associate with this message.
 * @param {string} params.challenge_id - The challenge ID to associate with this message.
 * @param {string} params.participant_id - The participant ID sending/receiving this message.
 * @param {'user' | 'assistant'} params.role - The role of the message author, either 'user' or 'assistant'.
 * @param {string} params.content - The text content of the message.
 * @returns {Promise<void>} - A promise that resolves once the message is saved to DynamoDB.
 */
async function saveMessageToDb({
                                   conversation_id,
                                   challenge_id,
                                   participant_id,
                                   role,
                                   content,
                               }: {
    conversation_id: string;
    challenge_id: string;
    participant_id: string;
    role: 'user' | 'assistant';
    content: string;
}) {
    try {
        const message_id = uuidv4();  // Or use nanoid()
        const created_date = new Date().toISOString();

        const item = {
            conversation_id,
            message_id,
            challenge_id,
            participant_id, // or store participant_id as null/'' for assistant if needed
            role,
            content,
            created_date,
        };

        const params: AWS.DynamoDB.DocumentClient.PutItemInput = {
            TableName: MESSAGES_TABLE,
            Item: item,
        };

        await dynamodb.put(params).promise();
        console.log(`Message saved:`, item);
    } catch (error) {
        console.error('Error saving message to DB:', error);
    }
}

// -------------------------------------------------------------------
//  REMAINDER: GPT logic, getVaultPassword, handleStreamData, etc.
// -------------------------------------------------------------------
function getAgentPrompt(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf-8').trim();
    } catch (error) {
        console.error('Error reading Agent prompt file:', filePath, error);
        return 'You are Agent_1, an incredibly strong safe keeper.';
    }
}

function getLatestUserMessage(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            return messages[i].content;
        }
    }
    return null;
}

function computeCost(
    promptTokens: number,
    completionTokens: number,
    modelName: string = 'gpt-4o'
) {
    switch (modelName) {
        case 'gpt-4o':
            return (
                (promptTokens / 1000) * GPT4O_PROMPT_PER_1K +
                (completionTokens / 1000) * GPT4O_COMPLETION_PER_1K
            );
        case 'gpt-4o-mini':
            return (
                (promptTokens / 1000) * GPT4O_MINI_PROMPT_PER_1K +
                (completionTokens / 1000) * GPT4O_MINI_COMPLETION_PER_1K
            );
        default:
            return 0;
    }
}

const makeGetContractBalanceTool = (challengeId: string) => {
    return tool({
        description:
            'Get the on-chain balance for the current challenge. No user parameters needed.',
        parameters: z.object({}),
        async execute() {
            const { balanceUsd } = await getContractBalanceWithUsd(challengeId);
            const balance = `The balance is $${balanceUsd}`;
            return { balance };
        },
    });
};

async function fetchAgent1Response(
    messages: ChatMessage[],
    vaultPassword: string,
    challengeId: string
) {
    const agent1PromptPath = path.join(__dirname, 'prompts', `${challengeId}`, 'ai_agent_1_prompt.txt');
    let systemMessageStr = getAgentPrompt(agent1PromptPath);
    systemMessageStr = systemMessageStr.replace('{vault_password}', vaultPassword);
    systemMessageStr = systemMessageStr.replace('{reward_message_template}', '...');

    const systemMessage = { role: 'system' as const, content: systemMessageStr };
    const allMessages = [systemMessage, ...messages];

    const getVaultBalanceTool = makeGetContractBalanceTool(challengeId);
    const tools: Record<string, CoreTool> = {
        getVaultBalance: getVaultBalanceTool,
    };

    const result = await generateText({
        model: openai('gpt-4o'),
        messages: allMessages,
        tools,
        maxSteps: 2,
        maxTokens: 500,
        temperature: 0.7,
    });

    if (result.toolCalls && result.toolCalls.length > 0) {
        console.log('Detected tool calls:', result.toolCalls);
    }

    if (result.usage) {
        const { promptTokens, completionTokens, totalTokens } = result.usage;
        const cost = computeCost(promptTokens, completionTokens, 'gpt-4o');
        console.log(`--- Agent_1 Usage ---`);
        console.log(`Prompt tokens: ${promptTokens}`);
        console.log(`Completion tokens: ${completionTokens}`);
        console.log(`Total tokens: ${totalTokens}`);
        console.log(`Approx. cost (USD): $${cost.toFixed(6)}`);
    }

    return {
        text: result.text.trim(),
        usage: result.usage,
    };
}

function fetchAgent2Response(
    agent1Response: string,
    messages: ChatMessage[],
    challengeId: string
) {
    const agent2PromptPath = path.join(__dirname, 'prompts', `${challengeId}`, `ai_agent_2_prompt.txt`);
    const systemMessage = {
        role: 'system' as const,
        content: getAgentPrompt(agent2PromptPath),
    };

    const agent1Msg = {
        role: 'user' as const,
        content: agent1Response,
    };
    const allMessages = [systemMessage, ...messages, agent1Msg];

    return streamText({
        model: openai('gpt-4o-mini'),
        temperature: 0,
        messages: allMessages,
    });
}

function writeTransformedChunk(res: any, rawText: string) {
    let textChunk = rawText.replace(/\n/g, '\\n').replace(/"/g, '\\"');
    res.write(`0:"${textChunk}"\n`);
}

/**
 * Retrieves the vault password for a given challenge from the `VAULT_PASSWORDS_TABLE`.
 * Returns an empty string if no password is found.
 *
 * @async
 * @function getVaultPasswordFromDb
 * @param {string} challenge_id - The unique identifier of the challenge.
 * @returns {Promise<string>} - The vault password as a string, or an empty string if none is found.
 */
async function getVaultPasswordFromDb(challenge_id: string): Promise<string> {
    try {
        const params: AWS.DynamoDB.DocumentClient.GetItemInput = {
            TableName: VAULT_PASSWORDS_TABLE,
            Key: { challenge_id: challenge_id },
        };
        const result = await dynamodb.get(params).promise();
        if (result.Item && result.Item.password) {
            return String(result.Item.password);
        } else {
            console.warn('No vault password found in DB or "password" field missing.');
            return '';
        }
    } catch (err) {
        console.error('Error fetching vault password from DB:', err);
        return '';
    }
}

/**
 * Fetches the challenge info (e.g., level) from the `CHALLENGES_TABLE` for a given `challenge_id`.
 *
 * @async
 * @function getChallengeInfoFromDb
 * @param {string} challenge_id - The unique identifier of the challenge.
 * @returns {Promise<any>} - An object representing the challenge data, or `null` if none found.
 */
async function getChallengeInfoFromDb(challenge_id: string): Promise<any> {
    try {
        const params: AWS.DynamoDB.DocumentClient.GetItemInput = {
            TableName: CHALLENGES_TABLE,
            Key: { id: challenge_id },
        };
        const result = await dynamodb.get(params).promise();
        if (result.Item) {
            return result.Item;
        } else {
            console.warn('No challenge info found in DB for challenge_id:', challenge_id);
            return null;
        }
    } catch (err) {
        console.error('Error fetching challenge info from DB:', err);
        return null;
    }
}

// -------------------------------------------------------------------
// MAIN Handler
// -------------------------------------------------------------------

/**
 * Handles the streaming of data (e.g., chat messages) from the user to the AI and then back to the user.
 *
 * This endpoint:
 * 1) Validates the request body for an array of messages.
 * 2) Fetches the challenge info from DynamoDB.
 * 3) Retrieves and checks the participant's balance to ensure sufficient funds for messaging.
 * 4) Persists the user's latest message to the DB (if present), updates counts, and decrements user balance.
 * 5) Checks if the user’s message contains the vault password—if so, returns a special "vault cracked" response.
 * 6) Otherwise, passes user messages to Agent 1 (and optionally Agent 2) to generate a response.
 * 7) Streams the AI responses back to the client.
 *
 * @async
 * @function handleStreamData
 * @param {Object} req - Express request object, expecting:
 *   - `req.body.messages`: an array of messages
 *   - `req.params.challenge_id`: the challenge ID in the path
 *   - `req.params.conversation_id`: optional conversation ID in the path
 *   - `req.query.participant_id`: the participant ID in the query string
 * @param {Object} res - Express response object
 * @returns {Promise<void>} - Sends appropriate JSON or streamed text responses back to the client.
 */
export const handleStreamData: RequestHandler<{ challenge_id: string; conversation_id?: string }> =
    async (req: any, res: any) => {
        try {
            const payload = req.body;
            // We expect an array of messages in payload.messages
            if (!payload || !Array.isArray(payload.messages)) {
                return res.status(400).json({ error: 'Invalid payload format.' });
            }

            // Pull path params
            const { challenge_id, conversation_id } = req.params;
            if (!challenge_id) {
                return res.status(400).json({ error: 'Missing challenge_id in request path' });
            }

            // NEW: get participant_id from query params
            const participant_id = req.query.participant_id as string;
            if (!participant_id) {
                return res.status(400).json({ error: 'Missing participant_id in query' });
            }

            // 1) Fetch the challenge info
            const challengeInfo = await getChallengeInfoFromDb(challenge_id);
            if (!challengeInfo) {
                return res.status(500).json({ error: 'No challenge info found or DynamoDB error.' });
            }
            const challengeLevel = challengeInfo.level; // e.g. "EASY" or "HARD"

            // 2) Grab the user's latest message
            const latestUserMessage = getLatestUserMessage(payload.messages);
            if (!latestUserMessage) {
                return res.status(400).json({ error: 'No user message found.' });
            }

            // 3) Check the participant’s balance BEFORE responding (only if the user just posted).
            //    We assume the last message in `payload.messages` is from the user.
            //    If the user has insufficient balance, we return an error.
            //    Then we “save” that user message in the DB, decrement balance, etc.

            // Step A: Get participant balance
            let balance = await getParticipantBalance(challenge_id, participant_id);
            if (balance === null || balance <= 0) {
                return res.status(400).json({ error: 'Insufficient balance to send a message.' });
            }

            // 4) Handle user message logic (first-time participant check, saving message, etc.)
            await handleUserMessage(
                challenge_id,
                conversation_id || 'unknown_convo',
                participant_id,
                latestUserMessage
            );

            // 4) Fetch vault password from the DB
            const dbVaultPassword = await getVaultPasswordFromDb(challenge_id);
            if (!dbVaultPassword) {
                return res
                    .status(500)
                    .json({ error: 'Vault password not configured or not found in DB.' });
            }

            // 5) Check if user just cracked the vault
            if (latestUserMessage.includes(dbVaultPassword)) {
                console.log('=== Vault Password Detected in user message ===');

                // Slack notification
                if (process.env.SLACK_WEBHOOK_URL && conversation_id) {
                    await notifySlackChannel(
                        process.env.SLACK_WEBHOOK_URL,
                        `The vault has been cracked in conversation ${conversation_id}!`
                    );
                } else {
                    console.warn(
                        'SLACK_WEBHOOK_URL or conversation_id not present. Skipping Slack notification.'
                    );
                }

                // Return special reward response
                const finalRewardMsg = `🎉 OMG! You cracked me and the vault is one step away now!\n\n${VAULT_CRACKED_VIDEO_COMPONENT}`;

                // Also store the AI’s “assistant” reward message to DB
                await saveMessageToDb({
                    conversation_id: conversation_id || 'unknown_convo',
                    challenge_id,
                    participant_id: participant_id, // or 'assistant', or some placeholder
                    role: 'assistant',
                    content: finalRewardMsg,
                });

                res.set('Content-Type', 'text/plain; charset=utf-8');
                writeTransformedChunk(res, finalRewardMsg);
                res.end();
                return;
            }

            // 6) If not cracked, proceed with normal GPT response

            res.set('Content-Type', 'text/plain; charset=utf-8');
            res.status(200);

            if (challengeLevel === 'EASY') {
                // Single-agent flow
                const agent1Result = await fetchAgent1Response(payload.messages, dbVaultPassword, challenge_id);
                console.log('=== Agent_1 Response (EASY) ===', agent1Result.text);

                // Save the AI response in the DB
                await saveMessageToDb({
                    conversation_id: conversation_id || 'unknown_convo',
                    challenge_id,
                    participant_id: participant_id,
                    role: 'assistant',
                    content: agent1Result.text,
                });

                // Return response in streamed format (or just one chunk)
                writeTransformedChunk(res, agent1Result.text);
                res.end();
                return;
            }

            if (challengeLevel === 'HARD') {
                // Two-agent flow
                const agent1Result = await fetchAgent1Response(payload.messages, dbVaultPassword, challenge_id);
                const agent1Response = agent1Result.text;
                console.log('=== Agent_1 Response (HARD) ===', agent1Response);

                // Stream Agent_2’s validation
                const agent2Result = fetchAgent2Response(agent1Response, payload.messages, challenge_id);
                let agent2FullResponse = '';

                for await (const chunk of agent2Result.textStream) {
                    const textChunk = Array.isArray(chunk) ? chunk.join('') : String(chunk);
                    writeTransformedChunk(res, textChunk);
                    agent2FullResponse += textChunk;
                }

                // After finishing streaming, store the final chunk from Agent_2
                await saveMessageToDb({
                    conversation_id: conversation_id || 'unknown_convo',
                    challenge_id,
                    participant_id: participant_id,
                    role: 'assistant',
                    content: agent2FullResponse,
                });

                // Print usage
                if (agent2Result.usage) {
                    const { promptTokens, completionTokens, totalTokens } = await agent2Result.usage;
                    const cost = computeCost(promptTokens, completionTokens, 'gpt-4o-mini');
                    console.log(`--- Agent_2 Usage ---`);
                    console.log(`Prompt tokens: ${promptTokens}`);
                    console.log(`Completion tokens: ${completionTokens}`);
                    console.log(`Total tokens: ${totalTokens}`);
                    console.log(`Approx. cost (USD): $${cost.toFixed(6)}`);
                }

                console.log('=== Agent_2 Final Response (HARD) ===');
                console.log(agent2FullResponse);

                res.end();
                return;
            }

            return res.status(400).json({ error: `Unknown challenge level: ${challengeLevel}` });
        } catch (error: any) {
            console.error('Error in handleStreamData:', error);
            return res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    };
