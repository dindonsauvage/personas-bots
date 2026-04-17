const fs = require("fs");
const DiscordPersona = require("./discord-persona");
const { BotRegistry } = require("./discord-persona");
const MistralClient = require("./mistral");

/**
 * @typedef GlobalConfig
 * @property {string[]?} ignoreChannels channels names patterns to ignore
 * @property {number?} frequenceFactor
 * @property {number?} delayAddional
 * @property {number?} delayFactor
 * @property {number?} typingTimeAddional
 * @property {number?} typingTimeFactor
 * @property {string?} timeZone timezone to use, example: "Europe/Paris"
 * @property {string?} mistralApiKey Mistral API key for AI responses
 * @property {string?} mistralModel Mistral model to use, default "mistral-small-latest"
 * @property {number?} mistralMaxTokens Max tokens for AI responses, default 150
 * @property {number?} botResponseFrequence Global frequency of bot-to-bot responses (0-1)
 * @property {number?} botChainMax Max consecutive bot messages in a chain
 */

/** @type {DiscordPersona[]} */
const personas = [];

/** @type {GlobalConfig} */
var globalConfig = {
	ignoreChannels: [],
	frequenceFactor: 1,
	delayAddional: 0,
	delayFactor: 1,
	typingTimeFactor: 1,
	typingTimeAddional: 0,
	timeZone: null,
	mistralApiKey: null,
	mistralModel: "mistral-small-latest",
	mistralMaxTokens: 150,
	botResponseFrequence: 0.15,
	botChainMax: 3
};

var configFile = "data/config.json";
if (fs.existsSync(configFile)) {
	var json = fs.readFileSync(configFile, "utf8");
	try {
		globalConfig = { ...globalConfig, ...JSON.parse(json) };
	} catch (/** @type {any} */ e) {
		console.error(`Error parsing config file: fix or delete it (${configFile})`);
		console.error("\t " + e.message);
		process.exit(1);
	}
	console.info('Config file loaded');
} else {
	fs.writeFileSync(configFile, JSON.stringify(globalConfig, null, 4));
	console.info("Config file created");
}

if (globalConfig.timeZone)
	process.env.TZ = globalConfig.timeZone;

// Initialize Mistral client if API key is configured
/** @type {MistralClient?} */
let mistralClient = null;
if (globalConfig.mistralApiKey) {
	mistralClient = new MistralClient({
		apiKey: globalConfig.mistralApiKey,
		model: globalConfig.mistralModel,
		maxTokens: globalConfig.mistralMaxTokens
	});
	console.info(`Mistral AI initialized (model: ${globalConfig.mistralModel})`);
} else {
	console.info("Mistral AI not configured (no API key)");
}

// Create shared bot registry for bot-to-bot conversations
const botRegistry = new BotRegistry();

var personasFolder = "data/personas";
for (let file of fs.readdirSync(personasFolder).filter(file => file.endsWith("json"))) {
	console.info(`Loading ${file}`);
	/** @type {DiscordPersona.Config} */
	let config = JSON.parse(fs.readFileSync(`${personasFolder}/${file}`, "utf8"));
	config.ignoreChannels = (config.ignoreChannels ?? []).concat(globalConfig.ignoreChannels ?? []);
	for (let r of config.responses ?? [])
		r.frequence = 1 - Math.pow(1 - (r.frequence ?? 0), globalConfig.frequenceFactor ?? 1);
	for (let r of config.routines ?? [])
		r.frequence = 1 - Math.pow(1 - (r.frequence ?? 0), globalConfig.frequenceFactor ?? 1);
	config.delay = (config.delay ?? 0) * (globalConfig.delayFactor ?? 1) + (globalConfig.delayAddional ?? 0);
	config.typingTime = (config.typingTime ?? 2000) * (globalConfig.typingTimeFactor ?? 1) + (globalConfig.typingTimeAddional ?? 0);
	config.config = file;
	// Inject Mistral client if persona has a personality defined
	if (mistralClient && config.personality) {
		config.mistralClient = mistralClient;
	}
	// Inject global bot-to-bot settings as defaults
	config.botResponseFrequence = config.botResponseFrequence ?? globalConfig.botResponseFrequence;
	config.botChainMax = config.botChainMax ?? globalConfig.botChainMax;
	personas.push(new DiscordPersona(config, botRegistry));
}

console.info(`${personas.length} personas loaded`);
if (mistralClient) {
	const aiCount = personas.filter(p => p.persona.personality).length;
	console.info(`${aiCount}/${personas.length} personas have AI enabled`);
}
