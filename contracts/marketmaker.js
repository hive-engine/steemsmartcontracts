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
    [{ index: 'symbol', descending: false },
     { index: 'priceDec', descending }],
  );
  return orders;
};

const countBalanceInBuyOrders = orders => orders.reduce((t, v) => t.plus(api.BigNumber(v.tokensLocked)), api.BigNumber(0));
const countBalanceInSellOrders = orders => orders.reduce((t, v) => t.plus(api.BigNumber(v.quantity)), api.BigNumber(0));

const getOrderData = (orders, myOrders, account) => {
  const data = {};
  data.topOrder = orders.length > 0 ? orders[0] : null;
  data.isTopMine = (data.topOrder && data.topOrder.account === account) ? true : false;
  data.topPrice = data.topOrder ? api.BigNumber(data.topOrder.price) : api.BigNumber(0);
  data.myTopPrice = myOrders.length > 0 ? api.BigNumber(myOrders[0].price) : api.BigNumber(0);
  data.numOrdersAtMyPrice = 0;
  if (data.myTopPrice.gt(0)) {
    data.numOrdersAtMyPrice = orders.reduce((t, v) => api.BigNumber(v.price).eq(data.myTopPrice) ? (t + 1) : t, 0);
    if (data.myTopPrice.eq(data.topPrice)) {
      data.isTopMine = true;
    }
  }
  return data;
};

const tickMarket = async (market) => {
  // sanity check
  if (!market.isEnabled) {
    return;
  }
  api.debug(`ticking market for user: ${market.account}, symbol: ${market.symbol}`);

  // convert market config into big numbers we can work with
  const maxBidPrice = api.BigNumber(market.maxBidPrice);
  const minSellPrice = api.BigNumber(market.minSellPrice);
  let maxBaseToSpend = api.BigNumber(market.maxBaseToSpend);
  const minBaseToSpend = api.BigNumber(market.minBaseToSpend);
  let maxTokensToSell = api.BigNumber(market.maxTokensToSell);
  const minTokensToSell = api.BigNumber(market.minTokensToSell);
  const priceIncrement = api.BigNumber(market.priceIncrement);
  const minSpread = api.BigNumber(market.minSpread);

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

  // get orders
  const buy_orders = await getOrderBook('buyBook', market.symbol, true);
  const sell_orders = await getOrderBook('sellBook', market.symbol, false);
  const my_buy_orders = buy_orders.filter(o => o.account === market.account);
  const my_sell_orders = sell_orders.filter(o => o.account === market.account);

  // if empty market, nothing for us to do
  const is_buy_book_empty = buy_orders.length == 0 || buy_orders.length == my_buy_orders.length;
  const is_sell_book_empty = sell_orders.length == 0 || sell_orders.length == my_sell_orders.length;
  if (is_buy_book_empty && is_sell_book_empty) {
    api.debug('order book for ' + market.symbol + ' is empty, nothing to do');
    return;
  }

  baseBalance = baseBalance.plus(countBalanceInBuyOrders(my_buy_orders));
  tokenBalance = tokenBalance.plus(countBalanceInSellOrders(my_sell_orders));

  api.debug('base balance: ' + baseBalance + ' ' + BASE_SYMBOL);
  api.debug('token balance: ' + tokenBalance + ' ' + market.symbol);
  api.debug('buy_orders:');
  api.debug(buy_orders);
  api.debug('sell_orders:');
  api.debug(sell_orders);
  api.debug('my buy orders:');
  api.debug(my_buy_orders);
  api.debug('my sell orders:');
  api.debug(my_sell_orders);

  if (baseBalance.lt(maxBaseToSpend)) {
    maxBaseToSpend = baseBalance;
  }
  if (tokenBalance.lt(maxTokensToSell)) {
    maxTokensToSell = tokenBalance;
  }

  // initialize order data
  const bb = getOrderData(buy_orders, my_buy_orders, market.account);
  const sb = getOrderData(sell_orders, my_sell_orders, market.account);

  api.debug('bb');
  api.debug(bb);
  api.debug('sb');
  api.debug(sb);

  let new_top_buy_price = bb.topPrice.plus(priceIncrement);
  if (new_top_buy_price.gt(maxBidPrice)) {
    new_top_buy_price = maxBidPrice;
  }
  let new_top_sell_price = sb.topPrice.minus(priceIncrement);
  if (new_top_sell_price.lt(minSellPrice)) {
    new_top_sell_price = minSellPrice;
  }

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
