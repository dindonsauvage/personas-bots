const https = require("https");

/**
 * @typedef MistralConfig
 * @property {string} apiKey Mistral API key
 * @property {string?} model Model to use, default "mistral-small-latest"
 * @property {number?} maxTokens Max tokens for response, default 150
 */

class MistralClient {
    /**
     * @param {MistralConfig} config
     */
    constructor({ apiKey, model, maxTokens }) {
        this.apiKey = apiKey;
        this.model = model || "mistral-small-latest";
        this.maxTokens = maxTokens || 150;
    }

    /**
     * Generate a response in character
     * @param {string} personality System prompt describing the persona
     * @param {{role: string, content: string}[]} messageHistory Recent messages for context
     * @param {string} currentMessage The message to respond to
     * @returns {Promise<string|null>} Generated response or null on error
     */
    async generateResponse(personality, messageHistory, currentMessage) {
        const messages = [
            {
                role: "system",
                content: personality
            },
            ...messageHistory.map(m => ({
                role: m.role === "self" ? "assistant" : "user",
                content: m.content
            })),
            {
                role: "user",
                content: currentMessage
            }
        ];

        try {
            const response = await this._request({
                model: this.model,
                messages,
                max_tokens: this.maxTokens,
                temperature: 0.9
            });

            if (response?.choices?.[0]?.message?.content) {
                return response.choices[0].message.content.trim();
            }
            return null;
        } catch (err) {
            console.error(`[Mistral] Error: ${err.message}`);
            return null;
        }
    }

    /**
     * Make a request to Mistral API
     * @param {object} body Request body
     * @returns {Promise<object>}
     */
    _request(body) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(body);
            const options = {
                hostname: "api.mistral.ai",
                port: 443,
                path: "/v1/chat/completions",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.apiKey}`,
                    "Content-Length": Buffer.byteLength(data)
                }
            };

            const req = https.request(options, (res) => {
                let responseData = "";
                res.on("data", chunk => responseData += chunk);
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(responseData);
                        if (res.statusCode !== 200) {
                            reject(new Error(`HTTP ${res.statusCode}: ${parsed.message || responseData}`));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${responseData.substring(0, 200)}`));
                    }
                });
            });

            req.on("error", reject);
            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error("Request timeout"));
            });
            req.write(data);
            req.end();
        });
    }
}

module.exports = MistralClient;
