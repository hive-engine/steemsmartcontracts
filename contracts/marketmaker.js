/* eslint-disable no-await-in-loop */
/* eslint-disable no-template-curly-in-string */
/* eslint-disable valid-typeof */
/* eslint-disable max-len */
/* eslint-disable no-continue */
/* global actions, api */

// either SWAP.HIVE or STEEMP
const BASE_SYMBOL = 'SWAP.HIVE';

actions.createSSC = async () => {
};

const getOrderBook = async (table, symbol, descending) => {
  const orders = await api.db.findInTable(
    'market',
    table,
    { symbol, },
    0,
    0,
    [{ index: 'symbol', descending },
     { index: 'priceDec', descending }],
  );
  return orders;
};

const tickMarket = async (market) => {
  api.debug(`ticking market for user: ${market.account}, symbol: ${market.symbol}`);

  // get account balances
  let baseBalance = api.BigNumber(0)
  let tokenBalance = api.BigNumber(0)
  const balances = await api.db.findInTable(
    'tokens',
    'balances',
    {
      account: market.account,
      symbol: {
        $in: [BASE_SYMBOL, market.symbol]
      },
    },
    2,
    0,
    [{ index: 'account', descending: false }],
  );
  for (let j = 0; j < balances.length; j += 1) {
    let balance = balances[j];
    if (balance.symbol === BASE_SYMBOL) {
      baseBalance = api.BigNumber(balance.balance);
    } else if (balance.symbol === market.symbol) {
      tokenBalance = api.BigNumber(balance.balance);
    }
  }

  api.debug('base balance: ' + baseBalance + ' ' + BASE_SYMBOL);
  api.debug('token balance: ' + tokenBalance + ' ' + market.symbol);

  // get orders
  buy_orders = await getOrderBook('buyBook', market.symbol, true);
  sell_orders = await getOrderBook('sellBook', market.symbol, false);

  api.debug('buy_orders:');
  api.debug(buy_orders);
  api.debug('sell_orders:');
  api.debug(sell_orders);

  // await api.executeSmartContract('market', 'buy', { account: market.account, symbol: market.symbol, quantity: "5", price: "0.75" });
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
