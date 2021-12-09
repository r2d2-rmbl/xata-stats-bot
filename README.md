# XATA Stats Telegram Bot
Simple telegram bot for obtaining simple stats about XATA reward pools across multiple chains.
* Use `/pools` to trigger requests
* Caches responses for 5mins to avoid excessive spamming of coingecko API

## Running on local
* Make a copy of 'env.example' and name it '.env'. Enter your RPC URLs, pair contract addresses, and telegram API keys.
* `yarn install`
* `yarn start`