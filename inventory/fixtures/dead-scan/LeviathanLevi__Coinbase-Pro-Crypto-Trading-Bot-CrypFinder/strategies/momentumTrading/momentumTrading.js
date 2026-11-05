// Excerpt of LeviathanLevi/Coinbase-Pro-Crypto-Trading-Bot-CrypFinder, strategies/momentumTrading/momentumTrading.js, seen in P5.
const CoinbasePro = require('coinbase-pro');

const apiURI = process.env.TRADING_ENV === "real" ? "https://api.pro.coinbase.com" : "https://api-public.sandbox.pro.coinbase.com";
const websocketURI = process.env.TRADING_ENV === "real" ? "wss://ws-feed.pro.coinbase.com" : "wss://ws-feed-public.sandbox.pro.coinbase.com";

const client = new CoinbasePro.AuthenticatedClient(key, secret, passphrase, apiURI);
const feed = new CoinbasePro.WebsocketClient(['BTC-USD'], websocketURI);
