const Discord = require("discord.js");
const Persona = require("./persona");

/**
 * @typedef DiscordConfig
 * @property {string} token Discord bot token
 * @property {number?} delay Delay before response
 * @property {number?} typingTime Time to type message
 * @property {number?} botResponseFrequence Frequency of responding to other bots (0-1)
 * @property {number?} botChainMax Max consecutive bot messages before stopping
 * 
 * @typedef {Persona.Config & DiscordConfig} Config
 */

/**
 * Shared registry to track all bot user IDs and prevent infinite loops
 */
class BotRegistry {
    constructor() {
        /** @type {Set<string>} */
        this.botIds = new Set();
        /** @type {Object.<string, {count: number, lastTime: number}>} */
        this.chainTracker = {};
        /** @type {Object.<string, string>} botId -> display name mapping */
        this.botNames = {};
    }

    /**
     * Register a bot's user ID and name
     * @param {string} botId
     * @param {string?} botName
     */
    register(botId, botName = null) {
        this.botIds.add(botId);
        if (botName) this.botNames[botId] = botName;
    }

    /**
     * Check if an ID belongs to a registered bot
     * @param {string} userId
     * @returns {boolean}
     */
    isBot(userId) {
        return this.botIds.has(userId);
    }

    /**
     * Get all registered bot names (for @mention purposes)
     * @returns {string[]}
     */
    getAllBotNames() {
        return Object.values(this.botNames);
    }

    /**
     * Get a random bot name that isn't the given one
     * @param {string} excludeName
     * @returns {string?}
     */
    getRandomOtherBotName(excludeName) {
        const others = Object.values(this.botNames).filter(n => n !== excludeName);
        return others.length > 0 ? others[Math.floor(Math.random() * others.length)] : null;
    }

    canChainRespond(channelId, maxChain = 3) {
        const now = Date.now();
        if (!this.chainTracker[channelId]) {
            this.chainTracker[channelId] = { count: 0, lastTime: 0 };
        }
        const tracker = this.chainTracker[channelId];
        if (now - tracker.lastTime > 60000) tracker.count = 0;
        return tracker.count < maxChain;
    }

    recordBotMessage(channelId) {
        const now = Date.now();
        if (!this.chainTracker[channelId]) {
            this.chainTracker[channelId] = { count: 0, lastTime: 0 };
        }
        const tracker = this.chainTracker[channelId];
        if (now - tracker.lastTime > 60000) tracker.count = 0;
        tracker.count++;
        tracker.lastTime = now;
    }

    recordHumanMessage(channelId) {
        if (this.chainTracker[channelId]) {
            this.chainTracker[channelId].count = 0;
        }
    }
}

/**
 * Persona for Discord
 */
class DiscordPersona {
    /**
     * @param {Config} config
     * @param {BotRegistry?} registry
     */
    constructor({ token, config, responses, routines, delay, typingTime, ignoreChannels,
                  personality, aiFrequence, mistralClient, botResponseFrequence, botChainMax,
                  reactions, reactionFrequence, affinities, typos, burstChance, delayNight, delayMorning }, registry = null) {
        /** @type {string} */
        this.config = config;
        /** @type {Persona} */
        this.persona = new Persona({
            config, responses, routines, ignoreChannels, personality, aiFrequence, mistralClient,
            reactions, reactionFrequence, affinities, typos, burstChance, delayNight, delayMorning
        });
        /** @type {number} */
        this.delay = delay || 0;
        /** @type {number} */
        this.typingTime = typingTime || 2000;
        /** @type {BotRegistry?} */
        this.registry = registry;
        /** @type {number} */
        this.botResponseFrequence = botResponseFrequence ?? 0.15;
        /** @type {number} */
        this.botChainMax = botChainMax ?? 3;
        /** @type {Discord.Client} */
        this.client = new Discord.Client({
            intents: [
                Discord.GatewayIntentBits.Guilds,
                Discord.GatewayIntentBits.GuildMessages,
                Discord.GatewayIntentBits.MessageContent,
                Discord.GatewayIntentBits.GuildMessageReactions
            ]
        });
        this.client.on("ready", () => {
            console.info(`[${this.config}] Logged in Discord as ${this.client.user?.tag}`);
            if (this.registry && this.client.user) {
                this.registry.register(this.client.user.id, this.client.user.username);
            }
        });
        this.client.on("messageCreate", async message => {
            if (message.author.id == this.client.user?.id) return;

            const channelName = "name" in message.channel ? message.channel.name : "";
            const authorName = message.member?.displayName || message.author.displayName || message.author.username;
            const isFromBot = this.registry?.isBot(message.author.id) || false;

            // Record message in history
            this.persona.recordMessage(channelName, authorName, message.content, false);

            // Track chain for bot-to-bot
            if (isFromBot) {
                this.registry?.recordBotMessage(message.channel.id);
            } else {
                this.registry?.recordHumanMessage(message.channel.id);
            }

            // If it's from another bot: respond with lower frequency + check chain limit
            if (isFromBot) {
                if (Math.random() > this.botResponseFrequence) return;
                if (!this.registry?.canChainRespond(message.channel.id, this.botChainMax)) return;
            }

            // Command handling (only from humans)
            if (!isFromBot && message.content.split(" ")[0] == `<@${this.client.user?.id}>`) {
                let result = this.command(message.content.replace(`<@${this.client.user?.id}>`, "").trim());
                if (result) {
                    message.channel.send(result);
                    return;
                }
            }

            // Let persona decide what to do
            const action = this.persona.onMessage(
                message.content,
                channelName,
                message.mentions.users.has(this.client.user?.id ?? "0"),
                authorName
            );

            if (!action) return;

            // Handle emoji reaction (can happen alongside text)
            if (action.reaction) {
                this._addReaction(message, action.reaction);
            }

            if (action.type === "reaction") {
                // Only a reaction, no text
                return;
            }

            if (action.type === "text") {
                const content = action.content;
                this._recordAndSend(message, channelName, content);
            }

            if (action.type === "ai") {
                action.promise.then(r => {
                    if (r) {
                        // Apply typo + burst to AI responses too
                        let content = r;
                        const typoResult = this.persona.applyTypo(content);
                        if (typoResult.length > 1) {
                            this._recordAndSend(message, channelName, typoResult);
                        } else {
                            const burstResult = this.persona.maybeBurst(content);
                            this._recordAndSend(message, channelName, burstResult.length > 1 ? burstResult : content);
                        }
                    }
                });
            }
        });
        this.client.login(token);
        setInterval(() => {
            let action = this.persona.onMinute(
                this.client.channels.cache.filter(channel => "messages" in channel)
                    .map(channel => "name" in channel ? channel.name : "")
            );
            if (!action) return;
            if (action.message && action.channel) {
                let textChannels = this.client.channels.cache.filter(channel => channel.type == Discord.ChannelType.GuildText);
                let channel = textChannels.find(channel => "name" in channel && channel.name == action.channel) ?? null;
                this.sendMessage(channel, action.message);
            }
        }, 60 * 1000);
    }

    /**
     * Record a response in history and send it, replying to the original message
     * @param {Discord.Message} originalMessage
     * @param {string} channelName
     * @param {string|string[]} content
     */
    _recordAndSend(originalMessage, channelName, content) {
        const firstMsg = typeof content === "string" ? content : content[0];
        this.persona.recordMessage(channelName, this.client.user?.username || this.config, firstMsg, true);
        this.registry?.recordBotMessage(originalMessage.channel.id);
        this.sendReply(originalMessage, content);
    }

    /**
     * Add an emoji reaction to a message
     * @param {Discord.Message} message
     * @param {string} emoji
     */
    async _addReaction(message, emoji) {
        try {
            // Delay reaction slightly for realism
            setTimeout(async () => {
                try {
                    // Try as unicode emoji first
                    await message.react(emoji);
                } catch {
                    // Try as custom emoji
                    if ("guild" in message.channel) {
                        const guildEmoji = message.guild?.emojis.cache.find(e => e.name === emoji.replace(/:/g, ''));
                        if (guildEmoji) await message.react(guildEmoji);
                    }
                }
            }, randomize(this.delay / 2, 40));
        } catch (err) {
            // Silently fail on reaction errors
        }
    }

    /**
     * Send a reply to a specific message with typing simulation
     * @param {Discord.Message} originalMessage
     * @param {string|string[]} message
     */
    async sendReply(originalMessage, message) {
        const channel = originalMessage.channel;
        if (!channel) return;
        if ("guild" in channel && channel.guild.members.me &&
            !channel.permissionsFor(channel.guild.members.me).has([
                Discord.PermissionFlagsBits.SendMessages,
                Discord.PermissionFlagsBits.ViewChannel
            ])) return;

        // Calculate delay with time-of-day multiplier
        const timeMultiplier = this.persona.getTimeDelayMultiplier();
        const adjustedDelay = this.delay * timeMultiplier;

        if (message instanceof Array) {
            if (message.length === 0) return;
            // First message is a reply, subsequent are regular sends
            const first = message[0];
            const rest = message.slice(1);

            const resolvedFirst = "guild" in channel
                ? await this._resolveEmojis(channel, first)
                : first;

            setTimeout(() => {
                channel.sendTyping();
                setTimeout(() => {
                    originalMessage.reply({ content: resolvedFirst, allowedMentions: { repliedUser: false } })
                        .catch(() => channel.send(resolvedFirst));

                    // Send remaining burst messages as regular messages
                    let cumulativeDelay = 0;
                    for (const part of rest) {
                        cumulativeDelay += randomize(this.typingTime * 0.6, 30) + 200;
                        const p = part;
                        setTimeout(async () => {
                            const resolved = "guild" in channel
                                ? await this._resolveEmojis(channel, p)
                                : p;
                            channel.sendTyping();
                            setTimeout(() => channel.send(resolved), randomize(this.typingTime * 0.5, 30));
                        }, cumulativeDelay);
                    }
                }, randomize(this.typingTime, 30));
            }, randomize(adjustedDelay, 60));
        } else {
            const resolved = "guild" in channel
                ? await this._resolveEmojis(channel, message)
                : message;

            setTimeout(() => {
                channel.sendTyping();
                setTimeout(() => {
                    originalMessage.reply({ content: resolved, allowedMentions: { repliedUser: false } })
                        .catch(() => channel.send(resolved));
                }, randomize(this.typingTime, 30));
            }, randomize(adjustedDelay, 60));
        }
    }

    /**
     * Send a message in a specific channel with typing (for routines, no reply)
     * @param {Discord.TextBasedChannel?} channel
     * @param {string|string[]} message
     */
    async sendMessage(channel, message) {
        if (!channel) return;
        if ("guild" in channel && channel.guild.members.me &&
            !channel.permissionsFor(channel.guild.members.me).has([
                Discord.PermissionFlagsBits.SendMessages,
                Discord.PermissionFlagsBits.ViewChannel
            ])) return;

        if (message instanceof Array) {
            if (message.length == 0) return;
            let remain = message.slice(1);
            setTimeout(() => this.sendMessage(channel, remain),
                randomize(this.delay / 2, 20) + randomize(this.typingTime, 10) + 100);
            message = message[0];
        }

        if ("guild" in channel)
            message = await this._resolveEmojis(channel, message);

        setTimeout(() => {
            channel.sendTyping();
            setTimeout(() => channel.send(message), randomize(this.typingTime, 30));
        }, randomize(this.delay, 60));
    }

    /**
     * Resolve custom emoji names to Discord emoji tags
     * @param {Discord.TextBasedChannel} channel
     * @param {string} message
     * @returns {Promise<string>}
     */
    async _resolveEmojis(channel, message) {
        if (!("guild" in channel)) return message;
        return replaceAsync(message, /(?<!<):([a-zA-Z0-9_]+):(?![0-9])/g, async (_match, emojiName) => {
            return await getEmoji(channel.guild, emojiName);
        });
    }

    /**
     * Get result of a command
     * @param {string} message
     * @returns {?string}
     */
    command(message) {
        switch (message.split(" ")[0]) {
            case "info":
                let info = this.persona.info();
                let base = `J'ai ${info.responses} répliques, ${info.routines} routines, ${info.expressions} expressions`;
                base += ` | ${info.reactions} reactions, ${info.affinities} affinités`;
                base += ` | je réponds en moyenne à ${Math.round(info.frequence * 100)}% des messages (${info.config})`;
                if (info.aiEnabled) base += ` | IA activée`;
                return base;
        }
        return null;
    }
}

/** @type {Object.<string, Discord.Collection<Discord.Snowflake, Discord.GuildEmoji>>} */
const emojisCache = {};

function getEmoji(guild, emojiName) {
    return new Promise((resolve, _reject) => {
        if (!emojisCache[guild.id]) {
            guild.emojis.fetch().then(emojis => {
                emojisCache[guild.id] = emojis.filter(emoji => emoji.available ?? false);
                var emoji = emojisCache[guild.id].find(emoji => emoji.name == emojiName);
                resolve(emoji ? `<:${emoji.name}:${emoji.id}>` : emojiName);
            });
        } else {
            var emoji = emojisCache[guild.id].find(emoji => emoji.name == emojiName);
            resolve(emoji ? `<:${emoji.name}:${emoji.id}>` : emojiName);
        }
    });
}

async function replaceAsync(str, regex, asyncFn) {
    const promises = [];
    str.replace(regex, (match, ...args) => {
        promises.push(asyncFn(match, ...args));
        return "";
    });
    const data = await Promise.all(promises);
    return str.replace(regex, () => data.shift());
}

function randomize(value, percent) {
    return value * (1 + (Math.random() - 0.5) * percent / 50);
}

module.exports = DiscordPersona;
module.exports.BotRegistry = BotRegistry;
