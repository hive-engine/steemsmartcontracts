/* eslint-disable no-await-in-loop */
/* eslint-disable no-template-curly-in-string */
/* eslint-disable valid-typeof */
/* eslint-disable max-len */
/* eslint-disable no-continue */
/* global actions, api */

actions.createSSC = async () => {
};

const tickMarket = async (market) => {
  //api.debug(`ticking market for user: ${market.account}, symbol: ${market.symbol}`);
  //await api.executeSmartContract('market', 'buy', { account: market.account, symbol: market.symbol, quantity: "5", price: "0.75" });
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
