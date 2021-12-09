require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const PairInfo = require("./reward-pair-info.js");

// replace the value below with the Telegram token you receive from @BotFather
const token = process.env.TELEGRAM_BOT_API;

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, {polling: true});

const checkingMessages = [
  'Finding alfa, hang on..',
  'Looking up stats, give me a minute..',
  'Baking numbers from the chain, please wait..',
];

const CACHE_TIMEOUT_SECONDS = 300;
let cachedMessage = '';
let cacheLastUpdated = 0;
let requestOngoing = false;
let chatsWaitingForMessage = new Set();

function getCheckingMessage() {
    return checkingMessages[Math.floor(Math.random() * (checkingMessages.length - 1)) + 1];
}

function getMessageFromStats(stats) {
    let msg = '';
    for (let pairStat of stats) {
        msg += `<b>Network: ${pairStat.network.toUpperCase()}, Pair: ${pairStat.stakingToken0}/${pairStat.stakingToken1}</b>\n`
        msg += `Pair TVL       : USD ${pairStat.pairTVL.toLocaleString()}\n`
        msg += `Farm Staked TVL: USD ${pairStat.stakedValue.toLocaleString()}\n`
        msg += `Farm APY       : ${(pairStat.poolApr / 100).toLocaleString()}%\n`
        msg += `\n`
    }
    return msg;
}

// Matches "/pools[anything]"
bot.onText(/\/pools/, (msg, match) => {
    const chatId = msg.chat.id;
    console.log('Received pool stats request.');

    const now = Math.round(Date.now() / 1000);
    if (cacheLastUpdated + CACHE_TIMEOUT_SECONDS > now) {
        console.log('cache hit');
        bot.sendMessage(chatId, cachedMessage, {parse_mode : "HTML"});
    } else {
        console.log('cache miss');
        chatsWaitingForMessage.add(chatId);
        if (requestOngoing) {
            console.log('received duplicate request')
            bot.sendMessage(chatId, "I'm still checking, will reply shortly..");
        } else {
            // send back the matched "whatever" to the chat
            requestOngoing = true;
            bot.sendMessage(chatId, getCheckingMessage());
            PairInfo.getStats()
                .then((stats) => {
                    cachedMessage = getMessageFromStats(stats);
                    cacheLastUpdated = now;
                    for (let eachWaitingChat of chatsWaitingForMessage) {
                        bot.sendMessage(eachWaitingChat, cachedMessage, {parse_mode: "HTML"});
                    }
                    chatsWaitingForMessage.clear();
                })
                .catch((e) => {
                    console.log(e);
                    bot.sendMessage(chatId, 'Unable to obtain stats');
                })
                .finally(() => requestOngoing = false)
        }
    }
});
