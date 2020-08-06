/* eslint-disable no-await-in-loop */
/* eslint-disable no-template-curly-in-string */
/* eslint-disable valid-typeof */
/* eslint-disable max-len */
/* eslint-disable no-continue */
/* global actions, api */

// either SWAP.HIVE or STEEMP
const BASE_SYMBOL = 'SWAP.HIVE';
const BASE_SYMBOL_PRECISION = 8;
const DEBUG_MODE = false;

actions.createSSC = async () => {
};

const getOrderBook = async (table, symbol, descending) => {
  const orders = await api.db.findInTable(
    'market',
    table,
    { symbol },
    0,
    0,
    [{ index: 'symbol', descending: false }, { index: 'priceDec', descending }],
  );
  return orders;
};

const cancelOrders = async (orders, type) => {
  for (let k = 0; k < orders.length; k += 1) {
    const order = orders[k];
    await api.executeSmartContract('market', 'cancel', { account: order.account, type, id: order.txId });
  }
};

// baseAmount and price should be of type BigNumber
const getClosestAmount = (baseCurrency, price, precision) => {
  const amount = baseCurrency.dividedBy(price);
  return amount.toFixed(precision);
};

const countBalanceInBuyOrders = orders => orders.reduce((t, v) => t.plus(api.BigNumber(v.tokensLocked)), api.BigNumber(0));
const countBalanceInSellOrders = orders => orders.reduce((t, v) => t.plus(api.BigNumber(v.quantity)), api.BigNumber(0));

const getOrderData = (orders, myOrders, account) => {
  const data = {};
  data.topOrder = orders.length > 0 ? orders[0] : null;
  // eslint-disable-next-line no-unneeded-ternary
  data.isTopMine = (data.topOrder && data.topOrder.account === account) ? true : false;
  data.topPrice = data.topOrder ? api.BigNumber(data.topOrder.price) : api.BigNumber(0);
  data.myTopPrice = myOrders.length > 0 ? api.BigNumber(myOrders[0].price) : api.BigNumber(0);
  data.numOrdersAtMyPrice = 0;
  if (data.myTopPrice.gt(0)) {
    data.numOrdersAtMyPrice = orders.reduce((t, v) => (api.BigNumber(v.price).eq(data.myTopPrice) ? (t + 1) : t), 0);
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
  if (DEBUG_MODE) {
    api.debug(`ticking market for user: ${market.account}, symbol: ${market.symbol}`);
  }

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
  let baseBalance = api.BigNumber(0);
  let tokenBalance = api.BigNumber(0);
  const balances = await api.db.findInTable(
    'tokens',
    'balances',
    {
      account: market.account,
      symbol: {
        $in: [BASE_SYMBOL, market.symbol],
      },
    },
    2,
    0,
    [{ index: 'account', descending: false }],
  );
  for (let j = 0; j < balances.length; j += 1) {
    const balance = balances[j];
    if (balance.symbol === BASE_SYMBOL) {
      baseBalance = api.BigNumber(balance.balance);
    } else if (balance.symbol === market.symbol) {
      tokenBalance = api.BigNumber(balance.balance);
    }
  }

  // get orders
  const buyOrders = await getOrderBook('buyBook', market.symbol, true);
  const sellOrders = await getOrderBook('sellBook', market.symbol, false);
  const myBuyOrders = buyOrders.filter(o => o.account === market.account);
  const mySellOrders = sellOrders.filter(o => o.account === market.account);

  // if empty market, nothing for us to do
  const isBuyBookEmpty = buyOrders.length === 0 || buyOrders.length === myBuyOrders.length;
  const isSellBookEmpty = sellOrders.length === 0 || sellOrders.length === mySellOrders.length;
  if (isBuyBookEmpty && isSellBookEmpty) {
    if (DEBUG_MODE) {
      api.debug(`order book for ${market.symbol} is empty, nothing to do`);
    }
    return;
  }

  baseBalance = baseBalance.plus(countBalanceInBuyOrders(myBuyOrders));
  tokenBalance = tokenBalance.plus(countBalanceInSellOrders(mySellOrders));

  if (DEBUG_MODE) {
    api.debug(`base balance: ${baseBalance} ${BASE_SYMBOL}`);
    api.debug(`token balance: ${tokenBalance} ${market.symbol}`);
    api.debug('buyOrders:');
    api.debug(buyOrders);
    api.debug('sellOrders:');
    api.debug(sellOrders);
    api.debug('my buy orders:');
    api.debug(myBuyOrders);
    api.debug('my sell orders:');
    api.debug(mySellOrders);
  }

  if (baseBalance.lt(maxBaseToSpend)) {
    maxBaseToSpend = baseBalance;
  }
  if (tokenBalance.lt(maxTokensToSell)) {
    maxTokensToSell = tokenBalance;
  }

  // initialize order data
  const bb = getOrderData(buyOrders, myBuyOrders, market.account);
  const sb = getOrderData(sellOrders, mySellOrders, market.account);

  if (DEBUG_MODE) {
    api.debug('bb');
    api.debug(bb);
    api.debug('sb');
    api.debug(sb);
  }

  let newTopBuyPrice = bb.topPrice.plus(priceIncrement);
  if (newTopBuyPrice.gt(maxBidPrice)) {
    newTopBuyPrice = maxBidPrice;
  }
  let newTopSellPrice = sb.topPrice.minus(priceIncrement);
  if (newTopSellPrice.lt(minSellPrice)) {
    newTopSellPrice = minSellPrice;
  }

  if (DEBUG_MODE) {
    api.debug(`newTopBuyPrice: ${newTopBuyPrice}`);
    api.debug(`newTopSellPrice: ${newTopSellPrice}`);
  }

  if (sellOrders.length > 0) {
    // make sure bid won't cross the ask
    if (newTopBuyPrice.gte(newTopSellPrice)) {
      return;
    }
    // make sure spread isn't too small
    const spread = newTopSellPrice.minus(newTopBuyPrice);
    if (spread.lt(minSpread)) {
      return;
    }
  }

  // decide if we should place new orders, and cancel old ones
  let shouldReplaceBuyOrder = false;
  if (myBuyOrders.length > 0
    && ((bb.myTopPrice.lt(bb.topPrice) && bb.topPrice.lt(maxBidPrice))
        || bb.myTopPrice.gt(maxBidPrice)
        || (bb.numOrdersAtMyPrice > 1 && bb.isTopMine)
        || (bb.numOrdersAtMyPrice > 1 && !bb.isTopMine && bb.myTopPrice.lt(newTopBuyPrice)))) {
    await cancelOrders(myBuyOrders, 'buy');
    shouldReplaceBuyOrder = true;
  }

  let shouldReplaceSellOrder = false;
  if (mySellOrders.length > 0
    && ((sb.myTopPrice.gt(sb.topPrice) && sb.topPrice.gt(minSellPrice))
        || sb.myTopPrice.lt(minSellPrice)
        || (sb.numOrdersAtMyPrice > 1 && sb.isTopMine)
        || (sb.numOrdersAtMyPrice > 1 && !sb.isTopMine && sb.myTopPrice.gt(newTopSellPrice)))) {
    await cancelOrders(mySellOrders, 'sell');
    shouldReplaceSellOrder = true;
  }

  // place new orders
  if ((myBuyOrders.length === 0 || shouldReplaceBuyOrder) && maxBaseToSpend.gte(minBaseToSpend)) {
    const tokensToBuy = getClosestAmount(maxBaseToSpend, newTopBuyPrice, market.precision);
    await api.executeSmartContract('market', 'buy', {
      account: market.account,
      symbol: market.symbol,
      quantity: tokensToBuy,
      price: newTopBuyPrice.toFixed(BASE_SYMBOL_PRECISION),
    });
  }
  if ((mySellOrders.length === 0 || shouldReplaceSellOrder) && maxTokensToSell.gte(minTokensToSell) && !isSellBookEmpty) {
    await api.executeSmartContract('market', 'sell', {
      account: market.account,
      symbol: market.symbol,
      quantity: maxTokensToSell.toFixed(market.precision),
      price: newTopSellPrice.toFixed(BASE_SYMBOL_PRECISION),
    });
  }
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
