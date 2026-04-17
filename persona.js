const MistralClient = require("./mistral");

/**
 * @typedef Response
 * @property {string?} pattern pattern to match with current message
 * @property {string?} contextPattern pattern to match against recent message history
 * @property {number?} frequence frequence between 0 and 1 of response
 * @property {(string|string[])[]?} expressions array of possible expressions
 * @property {string|string[]?} expression only if one expression
 * @property {boolean} whenMention only use when mention
 * @property {string[]?} channels array of channel id allowed, default is all
 */

/**
 * @typedef Routine
 * @property {[string,string]?} between two time between routine can be sent, example : ["10:00", "18:00"]
 * @property {number?} frequence probability of it being sent every minute
 * @property {(string|string[])[]?} expressions array of possible expressions
 * @property {(string|string[])?} expression only if one expression
 * @property {string[]?} channels array of channel id allowed, default is all
 */

/**
 * @typedef {Object.<string, number>} Affinities user name -> frequency multiplier
 */

/**
 * @typedef TypoRule
 * @property {number} chance probability of making a typo (0-1)
 * @property {string[]} corrections correction prefixes like "*", "pardon,", etc.
 */

/**
 * @typedef Config
 * @property {string} config configuration name
 * @property {Response[]?} responses possible responses
 * @property {Routine[]?} routines possible routines
 * @property {string[]?} ignoreChannels channels names patterns to ignore
 * @property {string?} personality personality description for AI responses
 * @property {number?} aiFrequence probability of using AI when no pattern matches (0-1)
 * @property {MistralClient?} mistralClient shared Mistral client instance
 * @property {string[]?} reactions emoji reactions instead of text responses
 * @property {number?} reactionFrequence probability of reacting with emoji (0-1)
 * @property {Affinities?} affinities response frequency multiplier per user
 * @property {TypoRule?} typos typo configuration
 * @property {number?} burstChance probability of splitting response into multi-messages (0-1)
 * @property {number?} delayNight delay multiplier for night hours (0-6h), default 3
 * @property {number?} delayMorning delay multiplier for morning (6-10h), default 2
 */

/** @type {number} Max messages kept in history per channel */
const MAX_HISTORY = 20;

/** Common typos: char -> replacement */
const TYPO_MAP = {
    'a': ['z', 'q', 's'], 'e': ['r', 'z', 'd'], 'i': ['u', 'o', 'k'],
    'o': ['i', 'p', 'l'], 'u': ['y', 'i', 'j'], 's': ['a', 'd', 'q'],
    'r': ['e', 't', 'f'], 't': ['r', 'y', 'g'], 'n': ['b', 'm', 'h'],
    'l': ['k', 'o', 'm']
};

class Persona {
    /**
     * @param {Config} config
     */
    constructor({ config, responses, routines, ignoreChannels, personality, aiFrequence, mistralClient,
                  reactions, reactionFrequence, affinities, typos, burstChance, delayNight, delayMorning }) {
        /** @type {string} */
        this.config = config;
        /** @type {Response[]} */
        this.responses = responses || [];
        /** @type {Routine[]} */
        this.routines = routines || [];
        /** @type {string[]} */
        this.ignoreChannels = ignoreChannels || [];
        /** @type {string?} */
        this.personality = personality || null;
        /** @type {number} */
        this.aiFrequence = aiFrequence ?? 0;
        /** @type {MistralClient?} */
        this.mistralClient = mistralClient || null;
        /** @type {Object.<string, {author: string, content: string, role: string}[]>} */
        this.messageHistory = {};
        /** @type {string[]} */
        this.reactions = reactions || ["💀", "😭", "😂", "👍"];
        /** @type {number} */
        this.reactionFrequence = reactionFrequence ?? 0;
        /** @type {Affinities} */
        this.affinities = affinities || {};
        /** @type {TypoRule?} */
        this.typos = typos || null;
        /** @type {number} */
        this.burstChance = burstChance ?? 0;
        /** @type {number} */
        this.delayNight = delayNight ?? 3;
        /** @type {number} */
        this.delayMorning = delayMorning ?? 2;
    }

    /**
     * Record a message in channel history
     * @param {string} channel channel name
     * @param {string} author message author name
     * @param {string} content message content
     * @param {boolean} isSelf whether this bot sent the message
     */
    recordMessage(channel, author, content, isSelf = false) {
        if (!this.messageHistory[channel]) {
            this.messageHistory[channel] = [];
        }
        this.messageHistory[channel].push({ author, content, role: isSelf ? "self" : "user" });
        if (this.messageHistory[channel].length > MAX_HISTORY) {
            this.messageHistory[channel] = this.messageHistory[channel].slice(-MAX_HISTORY);
        }
    }

    /**
     * Get recent history for a channel
     * @param {string} channel
     * @returns {{author: string, content: string, role: string}[]}
     */
    getHistory(channel) {
        return this.messageHistory[channel] || [];
    }

    /**
     * Get the affinity multiplier for a given author
     * @param {string} authorName
     * @returns {number} multiplier (1 = normal, >1 = more likely, <1 = less likely)
     */
    getAffinityMultiplier(authorName) {
        const lower = authorName.toLowerCase();
        for (const [name, mult] of Object.entries(this.affinities)) {
            if (lower.includes(name.toLowerCase())) return mult;
        }
        return 1;
    }

    /**
     * Get delay multiplier based on current hour
     * @returns {number}
     */
    getTimeDelayMultiplier() {
        const hour = new Date().getHours();
        if (hour >= 0 && hour < 6) return this.delayNight;
        if (hour >= 6 && hour < 10) return this.delayMorning;
        return 1;
    }

    /**
     * Decide if the persona should react with an emoji instead of text
     * @returns {string?} emoji to react with, or null
     */
    shouldReact() {
        if (this.reactionFrequence > 0 && Math.random() < this.reactionFrequence) {
            return pickRandom(this.reactions);
        }
        return null;
    }

    /**
     * Apply a random typo to a message and return [typo_msg, correction_msg] or just [msg]
     * @param {string} msg
     * @returns {string[]}
     */
    applyTypo(msg) {
        if (!this.typos || Math.random() > this.typos.chance) return [msg];
        if (msg.length < 4) return [msg];

        // Pick a random position to introduce a typo
        const chars = msg.split('');
        const candidates = [];
        for (let i = 0; i < chars.length; i++) {
            if (TYPO_MAP[chars[i].toLowerCase()]) candidates.push(i);
        }
        if (candidates.length === 0) return [msg];

        const pos = pickRandom(candidates);
        const original = chars[pos];
        const replacements = TYPO_MAP[original.toLowerCase()];
        chars[pos] = pickRandom(replacements);
        const typoMsg = chars.join('');

        const correctionPrefix = pickRandom(this.typos.corrections || ["*"]);
        const correction = `${correctionPrefix}${msg}`;

        return [typoMsg, correction];
    }

    /**
     * Maybe split a message into a burst of 2-3 short messages
     * @param {string} msg
     * @returns {string[]}
     */
    maybeBurst(msg) {
        if (Math.random() > this.burstChance) return [msg];
        if (msg.length < 10) return [msg];

        // Split on natural boundaries: punctuation, linebreaks
        const parts = msg.split(/(?<=[.!?…])\s+|(?:\n)+/).filter(p => p.trim());
        if (parts.length >= 2) return parts.slice(0, 3);

        // If no natural split, try splitting mid-sentence on commas
        const commaParts = msg.split(/,\s*/).filter(p => p.trim());
        if (commaParts.length >= 2) return commaParts.slice(0, 3);

        return [msg];
    }

    /**
     * Inform the persona that a message was received
     * @param {string} message content of the message received
     * @param {string} channel channel name or identifier
     * @param {boolean} mentioned true if the persona was mentioned
     * @param {string} authorName name of the message author
     * @returns {{type: "text", content: string|string[]} | {type: "reaction", emoji: string} | {type: "ai", promise: Promise} | null}
     */
    onMessage(message, channel = "", mentioned = false, authorName = "") {
        if (!filterChannels([channel], this.ignoreChannels)[0])
            return null;

        const affinityMult = this.getAffinityMultiplier(authorName);
        const history = this.getHistory(channel);

        // Check for emoji reaction first (independent of text response)
        const reactionEmoji = this.shouldReact();

        for (let response of this.responses) {
            if (response.channels && !response.channels.includes(channel)) continue;

            // Apply affinity multiplier to frequency
            const adjustedFreq = Math.min(1, (response.frequence || 0) * affinityMult);
            if (!(response.whenMention && mentioned) && (Math.random() > adjustedFreq)) continue;

            // Check contextPattern against recent history
            if (response.contextPattern) {
                const recentText = history.map(m => m.content).join(" ");
                if (!recentText.match(new RegExp(response.contextPattern, "i"))) continue;
            }

            var match = response.pattern
                ? message.match(new RegExp(response.pattern, "i"))
                : [message];
            if (match) {
                let expression = response.expressions ? pickRandom(response.expressions) : response.expression ?? [];
                let result = expression instanceof Array ? expression.map(e => format(e, match ?? [])) : format(expression, match);

                // Replace {author} placeholder with actual author name
                if (typeof result === "string") {
                    result = result.replace(/\{author\}/gi, authorName);
                }

                // Apply typo chance
                if (typeof result === "string") {
                    const typoResult = this.applyTypo(result);
                    if (typoResult.length > 1) return { type: "text", content: typoResult, reaction: reactionEmoji };
                }

                // Apply burst chance
                if (typeof result === "string") {
                    const burstResult = this.maybeBurst(result);
                    if (burstResult.length > 1) return { type: "text", content: burstResult, reaction: reactionEmoji };
                }

                return { type: "text", content: result, reaction: reactionEmoji };
            }
        }

        // AI fallback: if no pattern matched and AI is configured
        if (this.mistralClient && this.personality && (mentioned || Math.random() < this.aiFrequence * affinityMult)) {
            return { type: "ai", promise: this._generateAIResponse(channel, message, authorName), reaction: reactionEmoji };
        }

        // No text response but maybe a reaction
        if (reactionEmoji) {
            return { type: "reaction", emoji: reactionEmoji };
        }

        return null;
    }

    /**
     * Generate an AI response using Mistral
     * @param {string} channel
     * @param {string} message
     * @param {string} authorName
     * @returns {Promise<string|null>}
     */
    async _generateAIResponse(channel, message, authorName) {
        const history = this.getHistory(channel);
        const formattedHistory = history.slice(-10).map(m => ({
            role: m.role === "self" ? "assistant" : "user",
            content: m.role === "self" ? m.content : `${m.author}: ${m.content}`
        }));

        const currentMessage = authorName ? `${authorName}: ${message}` : message;

        try {
            const response = await this.mistralClient.generateResponse(
                this.personality,
                formattedHistory,
                currentMessage
            );
            return response;
        } catch (err) {
            console.error(`[${this.config}] AI error: ${err.message}`);
            return null;
        }
    }

    /**
     * Inform the persona that a minute has passed
     * @param {string[]} channels list of channels names or identifiers
     * @returns {{message: string | string[], channel: string?}?} message the persona would send
     */
    onMinute(channels) {
        for (let routine of this.routines) {
            if (!testBetween(routine.between) || (Math.random() > (routine.frequence || 0))) continue;
            return {
                message: routine.expressions ? pickRandom(routine.expressions) : routine.expression ?? [],
                channel: pickRandom(filterChannels(channels, this.ignoreChannels, routine.channels ?? []))
            };
        }
        return null;
    }

    /**
     * Get info about the persona
     */
    info() {
        return {
            config: this.config,
            responses: Object.keys(this.responses).length,
            routines: Object.keys(this.routines).length,
            expressions: [...this.responses, ...this.routines].reduce((n, r) => n + (r.expressions?.length || 1), 0),
            frequence: this.responses.reduce((f, r) => r.pattern ? f : f + (1 - f) * (r.frequence || 0), 0),
            aiEnabled: !!(this.mistralClient && this.personality),
            reactions: this.reactions.length,
            affinities: Object.keys(this.affinities).length
        };
    }
}

/**
 * @param {string} str formating string
 * @param {string[]} args arguments
 * @returns {string} formated string
 */
function format(str, args) {
    return str.replace(/{([0-9]+)}/g, function (match, index) {
        return typeof args[index] == "undefined" ? match : args[index];
    });
}

/**
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function pickRandom(arr) {
    return arr[Math.floor(arr.length * Math.random())];
}

/**
 * Test if actual time is between interval
 * @param {[string,string]?} interval
 * @returns {boolean}
 */
function testBetween(interval) {
    if (!interval) return true;
    var now = new Date().getHours() * 60 + new Date().getMinutes();
    var time1 = Number(interval[0].split(":")[0] || 0) * 60 + Number(interval[0].split(":")[1] || 0);
    var time2 = Number(interval[1].split(":")[0] || 0) * 60 + Number(interval[1].split(":")[1] || 0);
    return time1 < time2 ? (time1 <= now && now < time2) : (time1 < now || now < time2);
}

/**
 * Filter channels
 * @param {string[]} channels
 * @param {string[]} ignorePatterns
 * @param {string[]} patterns
 * @returns {string[]}
 */
function filterChannels(channels, ignorePatterns, patterns = []) {
    return channels.filter(channel => {
        for (let iPattern of ignorePatterns)
            if (channel.match(new RegExp(iPattern, "i")))
                return false;
        if (patterns.length == 0) return true;
        for (let pattern of patterns)
            if (channel.match(new RegExp(pattern, "i")))
                return true;
        return false;
    });
}

module.exports = Persona;
