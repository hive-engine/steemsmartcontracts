/* eslint-disable no-await-in-loop */
/* eslint-disable no-template-curly-in-string */
/* eslint-disable valid-typeof */
/* eslint-disable max-len */
/* eslint-disable no-continue */
/* global actions, api */

// BEE tokens on Hive Engine, ENG on Steem Engine, and SSC on the testnet
const UTILITY_TOKEN_SYMBOL = 'BEE';

// either SWAP.HIVE or STEEMP
const BASE_SYMBOL = 'SWAP.HIVE';
const BASE_SYMBOL_PRECISION = 8;

// either HIVE or STEEM
const CHAIN_TYPE = 'HIVE';

actions.createSSC = async () => {
};

const tickMarket = async (market) => {
  api.debug(`ticking market for user: ${market.account}, symbol: ${market.symbol}`);
};

actions.tick = async (payload) => {
  if (api.sender !== 'null') return;

  const {
    markets,
  } = payload;

  for (let i = 0; i < markets.length; i += 1) {
    await tickMarket(markets[i]);  
  }
};
