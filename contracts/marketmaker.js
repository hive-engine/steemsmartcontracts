/* eslint-disable no-await-in-loop */
/* eslint-disable no-template-curly-in-string */
/* eslint-disable valid-typeof */
/* eslint-disable max-len */
/* eslint-disable no-continue */
/* global actions, api */

// either SWAP.HIVE or STEEMP
const BASE_SYMBOL = 'STEEMP';
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
    [{ index: 'priceDec', descending }, { index: '_id', descending: false }],
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

const getOrderData = (orders, myOrders, account, qtyLimit) => {
  const data = {};
  let counter = 0;
  data.topOrder = null;
  while (counter < orders.length) {
    if (qtyLimit.lt(orders[counter].quantity)) {
      data.topOrder = orders[counter];
      break;
    }
    counter += 1;
  }
  // eslint-disable-next-line no-unneeded-ternary
  data.isTopMine = (data.topOrder && data.topOrder.account === account) ? true : false;
  data.topPrice = data.topOrder ? api.BigNumber(data.topOrder.price) : api.BigNumber(0);

  counter += 1;
  data.nextTopPrice = api.BigNumber(0);
  while (counter < orders.length) {
    const nextTopPrice = api.BigNumber(orders[counter].price);
    if (!nextTopPrice.eq(data.topPrice) && qtyLimit.lt(orders[counter].quantity)) {
      data.nextTopPrice = nextTopPrice;
      break;
    }
    counter += 1;
  }

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

const tickMarket = async (market, txIdPrefix) => {
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
  let priceIncrement = api.BigNumber(market.priceIncrement);
  const minSpread = api.BigNumber(market.minSpread);
  const maxDistFromNext = api.BigNumber(market.maxDistFromNext);
  const ignoreOrderQtyLt = api.BigNumber(market.ignoreOrderQtyLt);

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
    [{ index: '_id', descending: false }],
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
  if (priceIncrement.gt(maxDistFromNext)) {
    priceIncrement = maxDistFromNext;
  }

  // initialize order data
  const bb = getOrderData(buyOrders, myBuyOrders, market.account, ignoreOrderQtyLt);
  const sb = getOrderData(sellOrders, mySellOrders, market.account, ignoreOrderQtyLt);

  if (DEBUG_MODE) {
    api.debug('bb');
    api.debug(bb);
    api.debug('sb');
    api.debug(sb);
  }

  const isMaxBuyDistExceeded = bb.topPrice.gt(bb.nextTopPrice.plus(maxDistFromNext)) || isBuyBookEmpty;
  let newTopBuyPrice = bb.topPrice.plus(priceIncrement);
  if (!isBuyBookEmpty && isMaxBuyDistExceeded) {
    newTopBuyPrice = bb.nextTopPrice.plus(priceIncrement);
  }
  if (newTopBuyPrice.gt(maxBidPrice)) {
    newTopBuyPrice = maxBidPrice;
  }

  const isMaxSellDistExceeded = sb.topPrice.lt(sb.nextTopPrice.minus(maxDistFromNext)) || isSellBookEmpty;
  let newTopSellPrice = sb.topPrice.minus(priceIncrement);
  if (!isSellBookEmpty && isMaxSellDistExceeded) {
    newTopSellPrice = sb.nextTopPrice.minus(priceIncrement);
  }
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
        || (bb.isTopMine && isMaxBuyDistExceeded)
        || (bb.numOrdersAtMyPrice > 1 && bb.isTopMine)
        || (bb.numOrdersAtMyPrice > 1 && !bb.isTopMine && bb.myTopPrice.lt(newTopBuyPrice)))) {
    await cancelOrders(myBuyOrders, 'buy');
    if (!(bb.isTopMine && isMaxBuyDistExceeded && !isBuyBookEmpty)) {
      shouldReplaceBuyOrder = true;
    }
  }

  let shouldReplaceSellOrder = false;
  if (mySellOrders.length > 0
    && ((sb.myTopPrice.gt(sb.topPrice) && sb.topPrice.gt(minSellPrice))
        || sb.myTopPrice.lt(minSellPrice)
        || (sb.isTopMine && isMaxSellDistExceeded)
        || (sb.numOrdersAtMyPrice > 1 && sb.isTopMine)
        || (sb.numOrdersAtMyPrice > 1 && !sb.isTopMine && sb.myTopPrice.gt(newTopSellPrice)))) {
    await cancelOrders(mySellOrders, 'sell');
    if (!(sb.isTopMine && isMaxSellDistExceeded && !isSellBookEmpty)) {
      shouldReplaceSellOrder = true;
    }
  }

  if (DEBUG_MODE) {
    api.debug(`shouldReplaceBuyOrder: ${shouldReplaceBuyOrder}`);
    api.debug(`shouldReplaceSellOrder: ${shouldReplaceSellOrder}`);
  }

  // place new orders
  let orderCount = 0;
  if ((myBuyOrders.length === 0 || shouldReplaceBuyOrder) && maxBaseToSpend.gte(minBaseToSpend)) {
    const tokensToBuy = getClosestAmount(maxBaseToSpend, newTopBuyPrice, market.precision);
    if (DEBUG_MODE) {
      api.debug(`placing buy order txId: ${txIdPrefix}-${orderCount}`);
    }
    await api.executeSmartContract('market', 'buy', {
      account: market.account,
      txId: `${txIdPrefix}-${orderCount}`,
      symbol: market.symbol,
      quantity: tokensToBuy,
      price: newTopBuyPrice.toFixed(BASE_SYMBOL_PRECISION),
    });
    orderCount += 1;
  }
  if ((mySellOrders.length === 0 || shouldReplaceSellOrder) && maxTokensToSell.gte(minTokensToSell) && sellOrders.length > 0) {
    if (DEBUG_MODE) {
      api.debug(`placing sell order txId: ${txIdPrefix}-${orderCount}`);
    }
    await api.executeSmartContract('market', 'sell', {
      account: market.account,
      txId: `${txIdPrefix}-${orderCount}`,
      symbol: market.symbol,
      quantity: maxTokensToSell.toFixed(market.precision),
      price: newTopSellPrice.toFixed(BASE_SYMBOL_PRECISION),
    });
    orderCount += 1;
  }
};

actions.tick = async (payload) => {
  if (api.sender !== 'null') return;

  const {
    markets,
    txIdBase,
  } = payload;

  for (let i = 0; i < markets.length; i += 1) {
    await tickMarket(markets[i], `${txIdBase}-${i}`);
  }
};
