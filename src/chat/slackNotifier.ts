// src/slackNotifier.ts
import axios from 'axios';

/**
 * Sends a Slack notification that the vault has been cracked.
 *
 * @param slackWebhookUrl - The Slack Webhook URL (e.g., from process.env.SLACK_WEBHOOK_URL)
 * @param slackMessageStr   - The slack message to send
 */
export async function notifySlackChannel(slackWebhookUrl: string, slackMessageStr: string): Promise<void> {
    // Build the Slack message payload
    const slackMessage = {
        text: slackMessageStr
    };

    try {
        // noinspection JSAnnotator
        const response = await axios.post(slackWebhookUrl, slackMessage, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.status !== 200) {
            throw new Error(
                `Request to Slack returned an error ${response.status}, response text: ${response.data}`
            );
        }
    } catch (err: any) {
        throw new Error(`Slack notification error: ${err.message}`);
    }
}
