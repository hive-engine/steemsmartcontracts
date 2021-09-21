/* eslint-disable no-await-in-loop */
/* global actions, api */

const UTILITY_TOKEN_SYMBOL = 'BEE';

// 30 days in seconds
const MAX_EXPIRATION_SECS = 2592000;
// fee in UTILITY TOKEN required to create a new pair
const PAIR_CREATION_FEE = '500';

const CONTRACT_NAME = 'dmarket';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pairs');

  if (tableExists === false) {
    await api.db.createTable('pairs', ['symbol', 'precision', 'allowedSymbols']);
    await api.db.createTable('buyBook', ['symbol', 'pair', 'account', 'priceDec', 'expiration', 'txId']);
    await api.db.createTable('sellBook', ['symbol', 'pair', 'account', 'priceDec', 'expiration', 'txId']);
    await api.db.createTable('tradesHistory', ['symbol', 'pair']);
    await api.db.createTable('metrics', ['symbol', 'pair']);

    // default global pairs
    const pairs = [
      {
        pair: 'BEE',
        precision: 8,
        allowedSymbols: true, // true - all tokens are allowed
      },
      {
        pair: 'SWAP.BTC',
        precision: 8,
        allowedSymbols: true, // true - all tokens are allowed
      },
    ];

    for (let i = 0; i < pairs.length; i += 1) {
      await api.db.insert('pairs', pairs[i]);
    }
  }
};

const transferIsSuccessful = (result, action, from, to, symbol, quantity) => {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens'
    && el.event === action
    && el.data.from === from
    && el.data.to === to
    && api.BigNumber(el.data.quantity).eq(quantity)
    && el.data.symbol === symbol) !== undefined) {
    return true;
  }

  return false;
};

const countDecimals = value => api.BigNumber(value).dp();

actions.addPair = async (payload) => {
  const {
    pair,
    symbol,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;
  if (!api.assert(pair && typeof pair === 'string', 'invalid pair')) return;
  if (!api.assert(symbol && typeof symbol === 'string', 'invalid symbol')) return;
  if (!api.assert(pair !== symbol, 'pair and symbol can not be the same')) return;

  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
  if (!api.assert(token, 'symbol does not exist')) return;

  const pairToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: pair });
  if (!api.assert(pairToken, 'pair symbol does not exist')) return;

  const pairInDb = await api.db.findOne('pairs', { pair });
  const pairUpdate = pairInDb || {
    pair,
    precision: pairToken.precision,
    allowedSymbols: [],
  };

  if (api.assert(pairUpdate.allowedSymbols !== true, 'can not add symbol to a global pair')
    && api.assert(pairUpdate.allowedSymbols.indexOf(symbol) === -1, 'symbol is already in the pair')) {
    pairUpdate.allowedSymbols.push(symbol);
  }

  const utilityToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });

  if (api.assert(utilityToken && utilityToken.balance
    && api.BigNumber(utilityToken.balance).gte(PAIR_CREATION_FEE), 'you must have enough tokens to cover the pair creation fee')) {
    // transfer fee for pair creation
    const feeTransfer = await api.executeSmartContract('tokens', 'transfer', {
      to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: PAIR_CREATION_FEE, isSignedWithActiveKey,
    });

    // make sure fee is transfered successfully
    if (!api.assert(transferIsSuccessful(feeTransfer,
      'transfer',
      api.sender,
      'null',
      UTILITY_TOKEN_SYMBOL,
      PAIR_CREATION_FEE), 'failed to transfer creation fee')) return;

    if (pairInDb) {
      // add the new symbol in the pair
      await api.db.update('pairs', pairUpdate);
    } else {
      // add new pair in the db
      await api.db.insert('pairs', pairUpdate);
    }

    api.emit('addPair', {
      pair,
      symbol,
    });
  }
};

actions.addGlobalPair = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      pair,
    } = payload;

    if (!api.assert(pair && typeof pair === 'string', 'invalid pair')) return;

    const pairToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: pair });
    if (!api.assert(pairToken, 'pair symbol does not exist')) return;

    const pairInDb = await api.db.findOne('pairs', { pair });
    const pairUpdate = pairInDb || {
      pair,
      precision: pairToken.precision,
      allowedSymbols: [],
    };

    if (api.assert(pairUpdate.allowedSymbols !== true, 'pair is already global')) {
      pairUpdate.allowedSymbols = true;
    }

    if (pairInDb) {
      // update the pair as global
      await api.db.update('pairs', pairUpdate);
    } else {
      // add new global pair
      await api.db.insert('pairs', pairUpdate);
    }

    api.emit('addGlobalPair', {
      pair,
    });
  }
};

const getMetric = async (symbol, pair) => {
  let metric = await api.db.findOne('metrics', { symbol, pair });

  if (metric === null) {
    metric = {};
    metric.symbol = symbol;
    metric.pair = pair;
    metric.volume = '0';
    metric.volumeExpiration = 0;
    metric.lastPrice = '0';
    metric.lowestAsk = '0';
    metric.highestBid = '0';
    metric.lastDayPrice = '0';
    metric.lastDayPriceExpiration = 0;
    metric.priceChangePair = '0';
    metric.priceChangePercent = '0';

    const newMetric = await api.db.insert('metrics', metric);
    return newMetric;
  }

  return metric;
};

const updateVolumeMetric = async (symbol, pair, pairPrecision, quantity, add = true) => {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;
  const metric = await getMetric(symbol, pair);

  if (add === true) {
    if (metric.volumeExpiration < timestampSec) {
      metric.volume = '0.000';
    }
    metric.volume = api.BigNumber(metric.volume)
      .plus(quantity)
      .toFixed(pairPrecision);
    metric.volumeExpiration = blockDate.setUTCDate(blockDate.getUTCDate() + 1) / 1000;
  } else {
    metric.volume = api.BigNumber(metric.volume)
      .minus(quantity)
      .toFixed(pairPrecision);
  }

  if (api.BigNumber(metric.volume).lt(0)) {
    metric.volume = '0.000';
  }

  await api.db.update('metrics', metric);
};

const updatePriceMetrics = async (symbol, pair, pairPrecision, price) => {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;

  const metric = await getMetric(symbol, pair);

  metric.lastPrice = price;

  if (metric.lastDayPriceExpiration < timestampSec) {
    metric.lastDayPrice = price;
    metric.lastDayPriceExpiration = blockDate.setUTCDate(blockDate.getUTCDate() + 1) / 1000;
    metric.priceChangePair = '0';
    metric.priceChangePercent = '0%';
  } else {
    metric.priceChangePair = api.BigNumber(price)
      .minus(metric.lastDayPrice)
      .toFixed(pairPrecision);
    metric.priceChangePercent = `${api.BigNumber(metric.priceChangePair).dividedBy(metric.lastDayPrice).multipliedBy(100).toFixed(2)}%`;
  }

  await api.db.update('metrics', metric);
};

const updateBidMetric = async (symbol, pair) => {
  const metric = await getMetric(symbol, pair);

  const buyOrderBook = await api.db.find('buyBook',
    {
      symbol,
      pair,
    }, 1, 0,
    [
      { index: 'priceDec', descending: true },
    ]);


  if (buyOrderBook.length > 0) {
    metric.highestBid = buyOrderBook[0].price;
  } else {
    metric.highestBid = '0';
  }

  await api.db.update('metrics', metric);
};

const updateAskMetric = async (symbol, pair) => {
  const metric = await getMetric(symbol, pair);

  const sellOrderBook = await api.db.find('sellBook',
    {
      symbol,
      pair,
    }, 1, 0,
    [
      { index: 'priceDec', descending: false },
    ]);

  if (sellOrderBook.length > 0) {
    metric.lowestAsk = sellOrderBook[0].price;
  } else {
    metric.lowestAsk = '0';
  }

  await api.db.update('metrics', metric);
};

const updateTradesHistory = async (type,
  buyer,
  seller,
  symbol,
  pair,
  pairPrecision,
  quantity,
  price,
  volume,
  buyTxId,
  sellTxId) => {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;
  const timestampMinus24hrs = blockDate.setUTCDate(blockDate.getUTCDate() - 1) / 1000;

  // clean history
  let tradesToDelete = await api.db.find(
    'tradesHistory',
    {
      symbol,
      pair,
      timestamp: {
        $lt: timestampMinus24hrs,
      },
    },
  );
  let nbTradesToDelete = tradesToDelete.length;

  while (nbTradesToDelete > 0) {
    for (let index = 0; index < nbTradesToDelete; index += 1) {
      const trade = tradesToDelete[index];
      await updateVolumeMetric(trade.symbol, trade.pair, pairPrecision, trade.volume, false);
      await api.db.remove('tradesHistory', trade);
    }
    tradesToDelete = await api.db.find(
      'tradesHistory',
      {
        symbol,
        pair,
        timestamp: {
          $lt: timestampMinus24hrs,
        },
      },
    );
    nbTradesToDelete = tradesToDelete.length;
  }

  // add order to the history
  const newTrade = {};
  newTrade.type = type;
  newTrade.buyer = buyer;
  newTrade.seller = seller;
  newTrade.symbol = symbol;
  newTrade.pair = pair;
  newTrade.quantity = quantity;
  newTrade.price = price;
  newTrade.timestamp = timestampSec;
  newTrade.volume = volume;
  newTrade.buyTxId = buyTxId;
  newTrade.sellTxId = sellTxId;
  await api.db.insert('tradesHistory', newTrade);
  await updatePriceMetrics(symbol, pair, pairPrecision, price);
};

const removeExpiredOrders = async (table) => {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;

  // clean orders
  let nbOrdersToDelete = 0;
  let ordersToDelete = await api.db.find(
    table,
    {
      expiration: {
        $lte: timestampSec,
      },
    },
  );

  nbOrdersToDelete = ordersToDelete.length;
  while (nbOrdersToDelete > 0) {
    for (let index = 0; index < nbOrdersToDelete; index += 1) {
      const order = ordersToDelete[index];
      let quantity;
      let symbol;

      if (table === 'buyBook') {
        symbol = order.pair;
        quantity = order.tokensLocked;
      } else {
        // eslint-disable-next-line prefer-destructuring
        symbol = order.symbol;
        // eslint-disable-next-line prefer-destructuring
        quantity = order.quantity;
      }

      // unlock tokens
      await api.transferTokens(order.account, symbol, quantity, 'user');

      await api.db.remove(table, order);

      if (table === 'buyBook') {
        api.emit('orderExpired', { type: 'buy', txId: order.txId });

        await updateAskMetric(order.symbol);
      } else {
        api.emit('orderExpired', { type: 'sell', txId: order.txId });

        await updateBidMetric(order.symbol);
      }
    }

    ordersToDelete = await api.db.find(
      table,
      {
        expiration: {
          $lte: timestampSec,
        },
      },
    );

    nbOrdersToDelete = ordersToDelete.length;
  }
};

const findMatchingSellOrders = async (order, tokenPrecision, pairPrecision) => {
  const {
    account,
    symbol,
    pair,
    priceDec,
  } = order;

  const buyOrder = order;
  let offset = 0;
  let volumeTraded = 0;

  await removeExpiredOrders('sellBook');

  // get the orders that match the symbol and the price
  let sellOrderBook = await api.db.find('sellBook', {
    symbol,
    pair,
    priceDec: {
      $lte: priceDec,
    },
  }, 1000, offset,
  [
    { index: 'priceDec', descending: false },
    { index: '_id', descending: false },
  ]);

  do {
    const nbOrders = sellOrderBook.length;
    let inc = 0;

    while (inc < nbOrders && api.BigNumber(buyOrder.quantity).gt(0)) {
      const sellOrder = sellOrderBook[inc];
      if (api.BigNumber(buyOrder.quantity).lte(sellOrder.quantity)) {
        let qtyTokensToSend = api.BigNumber(sellOrder.price)
          .multipliedBy(buyOrder.quantity)
          .toFixed(pairPrecision);

        if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
          qtyTokensToSend = api.BigNumber(sellOrder.price)
            .multipliedBy(buyOrder.quantity)
            .toFixed(pairPrecision, api.BigNumber.ROUND_DOWN);
        }

        if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
          && api.BigNumber(buyOrder.quantity).gt(0), 'the order cannot be filled')) {
          // transfer the tokens to the buyer
          await api.transferTokens(account, symbol, buyOrder.quantity, 'user');

          // transfer the tokens to the seller
          await api.transferTokens(sellOrder.account, pair, qtyTokensToSend, 'user');

          // update the sell order
          const qtyLeftSellOrder = api.BigNumber(sellOrder.quantity)
            .minus(buyOrder.quantity)
            .toFixed(tokenPrecision);
          const nbTokensToFillOrder = api.BigNumber(sellOrder.price)
            .multipliedBy(qtyLeftSellOrder)
            .toFixed(pairPrecision);

          if (api.BigNumber(qtyLeftSellOrder).gt(0)
            && (api.BigNumber(nbTokensToFillOrder).gte('0.00000001'))) {
            sellOrder.quantity = qtyLeftSellOrder;

            await api.db.update('sellBook', sellOrder);
          } else {
            if (api.BigNumber(qtyLeftSellOrder).gt(0)) {
              // transfer remaining tokens to seller since the order can no longer be filled
              await api.transferTokens(sellOrder.account, symbol, qtyLeftSellOrder, 'user');
            }
            api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });
            await api.db.remove('sellBook', sellOrder);
          }

          // unlock remaining tokens, update the quantity to get and remove the buy order
          const tokensToUnlock = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(pairPrecision);

          if (api.BigNumber(tokensToUnlock).gt(0)) {
            // transfer any dust tokens remaining to buyer
            await api.transferTokens(account, pair, tokensToUnlock, 'user');
          }

          // add the trade to the history
          await updateTradesHistory('buy', account, sellOrder.account, symbol, pair, pairPrecision, buyOrder.quantity, sellOrder.price, qtyTokensToSend, buyOrder.txId, sellOrder.txId);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);

          // set quantity to zero to stop the loop
          buyOrder.quantity = '0';
          await api.db.remove('buyBook', buyOrder);
          api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });
        }
      } else {
        let qtyTokensToSend = api.BigNumber(sellOrder.price)
          .multipliedBy(sellOrder.quantity)
          .toFixed(pairPrecision);

        if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
          qtyTokensToSend = api.BigNumber(sellOrder.price)
            .multipliedBy(sellOrder.quantity)
            .toFixed(pairPrecision, api.BigNumber.ROUND_DOWN);
        }

        if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
          && api.BigNumber(buyOrder.quantity).gt(0), 'the order cannot be filled')) {
          // transfer the tokens to the buyer
          await api.transferTokens(account, symbol, sellOrder.quantity, 'user');

          // transfer the tokens to the seller
          await api.transferTokens(sellOrder.account, pair, qtyTokensToSend, 'user');

          // remove the sell order
          await api.db.remove('sellBook', sellOrder);
          api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });

          // update tokensLocked and the quantity to get
          buyOrder.tokensLocked = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(pairPrecision);
          buyOrder.quantity = api.BigNumber(buyOrder.quantity)
            .minus(sellOrder.quantity)
            .toFixed(tokenPrecision);

          // check if the order can still be filled
          const nbTokensToFillOrder = api.BigNumber(buyOrder.price)
            .multipliedBy(buyOrder.quantity)
            .toFixed(pairPrecision);

          if (api.BigNumber(nbTokensToFillOrder).lt('0.00000001')) {
            await api.transferTokens(account, pair, buyOrder.tokensLocked, 'user');

            // stop the loop and remove buy order if it can not be filled
            buyOrder.quantity = '0';
            await api.db.remove('buyBook', buyOrder);
            api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });
          }

          // add the trade to the history
          await updateTradesHistory('buy', account, sellOrder.account, symbol, pair, pairPrecision, sellOrder.quantity, sellOrder.price, qtyTokensToSend, buyOrder.txId, sellOrder.txId);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);
        }
      }

      inc += 1;
    }

    offset += 1000;

    if (api.BigNumber(buyOrder.quantity).gt(0)) {
      // get the orders that match the symbol and the price
      sellOrderBook = await api.db.find('sellBook', {
        symbol,
        pair,
        priceDec: {
          $lte: priceDec,
        },
      }, 1000, offset,
      [
        { index: 'priceDec', descending: false },
        { index: '_id', descending: false },
      ]);
    }
  } while (sellOrderBook.length > 0 && api.BigNumber(buyOrder.quantity).gt(0));

  // update the buy order if partially filled
  if (api.BigNumber(buyOrder.quantity).gt(0)) {
    await api.db.update('buyBook', buyOrder);
  }

  // update metrics
  if (api.BigNumber(volumeTraded).gt(0)) {
    await updateVolumeMetric(symbol, pair, pairPrecision, volumeTraded);
  }
  await updateAskMetric(symbol, pair);
  await updateBidMetric(symbol, pair);
};

const findMatchingBuyOrders = async (order, tokenPrecision, pairPrecision) => {
  const {
    account,
    symbol,
    pair,
    priceDec,
  } = order;

  const sellOrder = order;
  let offset = 0;
  let volumeTraded = 0;

  await removeExpiredOrders('buyBook');

  // get the orders that match the symbol and the price
  let buyOrderBook = await api.db.find('buyBook', {
    symbol,
    pair,
    priceDec: {
      $gte: priceDec,
    },
  }, 1000, offset,
  [
    { index: 'priceDec', descending: true },
    { index: '_id', descending: false },
  ]);

  do {
    const nbOrders = buyOrderBook.length;
    let inc = 0;

    while (inc < nbOrders && api.BigNumber(sellOrder.quantity).gt(0)) {
      const buyOrder = buyOrderBook[inc];
      if (api.BigNumber(sellOrder.quantity).lte(buyOrder.quantity)) {
        let qtyTokensToSend = api.BigNumber(buyOrder.price)
          .multipliedBy(sellOrder.quantity)
          .toFixed(pairPrecision);

        if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
          qtyTokensToSend = api.BigNumber(buyOrder.price)
            .multipliedBy(sellOrder.quantity)
            .toFixed(pairPrecision, api.BigNumber.ROUND_DOWN);
        }

        if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
          && api.BigNumber(sellOrder.quantity).gt(0), 'the order cannot be filled')) {
          // transfer the tokens to the buyer
          await api.transferTokens(buyOrder.account, symbol, sellOrder.quantity, 'user');

          // transfer the tokens to the seller
          await api.transferTokens(account, pair, qtyTokensToSend, 'user');

          // update the buy order
          const qtyLeftBuyOrder = api.BigNumber(buyOrder.quantity)
            .minus(sellOrder.quantity)
            .toFixed(tokenPrecision);

          const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(pairPrecision);
          const nbTokensToFillOrder = api.BigNumber(buyOrder.price)
            .multipliedBy(qtyLeftBuyOrder)
            .toFixed(pairPrecision);

          if (api.BigNumber(qtyLeftBuyOrder).gt(0)
            && (api.BigNumber(nbTokensToFillOrder).gte('0.00000001'))) {
            buyOrder.quantity = qtyLeftBuyOrder;
            buyOrder.tokensLocked = buyOrdertokensLocked;

            await api.db.update('buyBook', buyOrder);
          } else {
            if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
              // transfer remaining tokens to buyer since the order can no longer be filled
              await api.transferTokens(buyOrder.account, pair, buyOrdertokensLocked, 'user');
            }
            api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });
            await api.db.remove('buyBook', buyOrder);
          }

          // add the trade to the history
          await updateTradesHistory('sell', buyOrder.account, account, symbol, pair, pairPrecision, sellOrder.quantity, buyOrder.price, qtyTokensToSend, buyOrder.txId, sellOrder.txId);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);

          // set quantity to zero to stop the loop
          sellOrder.quantity = 0;
          await api.db.remove('sellBook', sellOrder);
          api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });
        }
      } else {
        let qtyTokensToSend = api.BigNumber(buyOrder.price)
          .multipliedBy(buyOrder.quantity)
          .toFixed(pairPrecision);

        if (qtyTokensToSend > buyOrder.tokensLocked) {
          qtyTokensToSend = api.BigNumber(buyOrder.price)
            .multipliedBy(buyOrder.quantity)
            .toFixed(pairPrecision, api.BigNumber.ROUND_DOWN);
        }

        if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
          && api.BigNumber(sellOrder.quantity).gt(0), 'the order cannot be filled')) {
          // transfer the tokens to the buyer
          await api.transferTokens(buyOrder.account, symbol, buyOrder.quantity, 'user');

          // transfer the tokens to the seller
          await api.transferTokens(account, pair, qtyTokensToSend, 'user');

          const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(pairPrecision);

          if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
            // transfer any dust tokens remaining to buyer
            await api.transferTokens(buyOrder.account, pair, buyOrdertokensLocked, 'user');
          }

          // remove the buy order
          await api.db.remove('buyBook', buyOrder);
          api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });

          // update the quantity to get
          sellOrder.quantity = api.BigNumber(sellOrder.quantity)
            .minus(buyOrder.quantity)
            .toFixed(tokenPrecision);

          // check if the order can still be filled
          const nbTokensToFillOrder = api.BigNumber(sellOrder.price)
            .multipliedBy(sellOrder.quantity)
            .toFixed(pairPrecision);

          if (api.BigNumber(nbTokensToFillOrder).lt('0.00000001')) {
            await api.transferTokens(account, symbol, sellOrder.quantity, 'user');

            // stop the loop and remove sell order if it can not be filled
            sellOrder.quantity = '0';
            await api.db.remove('sellBook', sellOrder);
            api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });
          }

          // add the trade to the history
          await updateTradesHistory('sell', buyOrder.account, account, symbol, pair, pairPrecision, buyOrder.quantity, buyOrder.price, qtyTokensToSend, buyOrder.txId, sellOrder.txId);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);
        }
      }

      inc += 1;
    }

    offset += 1000;

    if (api.BigNumber(sellOrder.quantity).gt(0)) {
      // get the orders that match the symbol and the price
      buyOrderBook = await api.db.find('buyBook', {
        symbol,
        pair,
        priceDec: {
          $gte: priceDec,
        },
      }, 1000, offset,
      [
        { index: 'priceDec', descending: true },
        { index: '_id', descending: false },
      ]);
    }
  } while (buyOrderBook.length > 0 && api.BigNumber(sellOrder.quantity).gt(0));

  // update the sell order if partially filled
  if (api.BigNumber(sellOrder.quantity).gt(0)) {
    await api.db.update('sellBook', sellOrder);
  }

  if (api.BigNumber(volumeTraded).gt(0)) {
    await updateVolumeMetric(symbol, pair, pairPrecision, volumeTraded);
  }
  await updateAskMetric(symbol, pair);
  await updateBidMetric(symbol, pair);
};

actions.buy = async (payload) => {
  const {
    account,
    txId,
    symbol,
    pair,
    quantity,
    price,
    expiration,
    isSignedWithActiveKey,
  } = payload;

  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;
  const finalTxId = (txId === undefined || api.sender !== 'null') ? api.transactionId : txId;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  if (!api.assert(finalAccount && typeof finalAccount === 'string' && api.isValidAccountName(finalAccount)
    && finalTxId && typeof finalTxId === 'string' && finalTxId.length > 0
    && symbol && typeof symbol === 'string'
    && pair && typeof pair === 'string'
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN()
    && price && typeof price === 'string' && !api.BigNumber(price).isNaN()
    && (expiration === undefined || (expiration && Number.isInteger(expiration) && expiration > 0)), 'invalid params')
  ) return;

  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

  // perform a few verifications
  if (!api.assert(token, 'symbol does not exist')) return;
  if (!api.assert(countDecimals(quantity) <= token.precision
    && api.BigNumber(quantity).gt(0), 'invalid quantity')) return;

  const pairInDb = await api.db.findOne('pairs', { pair });

  // check if symbol is included in allowedSymbols or the pair is global
  if (!api.assert(pairInDb && (pairInDb.allowedSymbols.indexOf(symbol) !== -1 || pairInDb.allowedSymbols === true), 'pair does not exist')) return;
  if (!api.assert(api.BigNumber(price).gt(0) && countDecimals(price) <= pairInDb.precision, 'invalid price')) return;

  const nbTokensToLock = api.BigNumber(price)
    .multipliedBy(quantity)
    .toFixed(pairInDb.precision);

  if (api.assert(api.BigNumber(nbTokensToLock).gte('0.00000001'), 'order cannot be placed as it cannot be filled')) {
    // lock the tokens in contract for safekeeping
    const tokenTransfer = await api.executeSmartContract('tokens', 'transferToContract', {
      from: finalAccount, to: CONTRACT_NAME, symbol: pair, quantity: nbTokensToLock,
    });

    // make sure tokens are locked
    if (api.assert(transferIsSuccessful(tokenTransfer, 'transferToContract', finalAccount, CONTRACT_NAME, pair, nbTokensToLock), 'failed to transfer tokens')) {
      const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
      const timestampSec = blockDate.getTime() / 1000;

      // order
      const order = {};

      order.txId = finalTxId;
      order.timestamp = timestampSec;
      order.account = finalAccount;
      order.symbol = symbol;
      order.pair = pair;
      order.quantity = api.BigNumber(quantity).toFixed(token.precision);
      order.price = api.BigNumber(price).toFixed(pairInDb.precision);
      order.priceDec = { $numberDecimal: order.price };
      order.tokensLocked = nbTokensToLock;
      order.expiration = expiration === undefined || expiration > MAX_EXPIRATION_SECS
        ? timestampSec + MAX_EXPIRATION_SECS
        : timestampSec + expiration;

      const orderInDb = await api.db.insert('buyBook', order);

      await findMatchingSellOrders(orderInDb, token.precision, pairInDb.precision);
    }
  }
};

actions.sell = async (payload) => {
  const {
    account,
    txId,
    symbol,
    pair,
    quantity,
    price,
    expiration,
    isSignedWithActiveKey,
  } = payload;

  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;
  const finalTxId = (txId === undefined || api.sender !== 'null') ? api.transactionId : txId;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  if (!api.assert(finalAccount && typeof finalAccount === 'string' && api.isValidAccountName(finalAccount)
    && finalTxId && typeof finalTxId === 'string' && finalTxId.length > 0
    && symbol && typeof symbol === 'string'
    && pair && typeof pair === 'string'
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN()
    && price && typeof price === 'string' && !api.BigNumber(price).isNaN()
    && (expiration === undefined || (expiration && Number.isInteger(expiration) && expiration > 0)), 'invalid params')
  ) return;

  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

  // perform a few verifications
  if (!api.assert(token, 'symbol does not exist')) return;
  if (!api.assert(countDecimals(quantity) <= token.precision
    && api.BigNumber(quantity).gt(0), 'invalid quantity')) return;

  const pairInDb = await api.db.findOne('pairs', { pair });

  // check if symbol is included in allowedSymbols or the pair is global
  if (!api.assert(pairInDb && (pairInDb.allowedSymbols.indexOf(symbol) !== -1 || pairInDb.allowedSymbols === true), 'pair does not exist')) return;
  if (!api.assert(api.BigNumber(price).gt(0) && countDecimals(price) <= pairInDb.precision, 'invalid price')) return;

  const nbTokensToFillOrder = api.BigNumber(price)
    .multipliedBy(quantity)
    .toFixed(pairInDb.precision);

  // check if order can be filled
  if (api.assert(api.BigNumber(nbTokensToFillOrder).gte('0.00000001'), 'order cannot be placed as it cannot be filled')) {
    // lock the tokens in contract for safekeeping
    const tokenTransfer = await api.executeSmartContract('tokens', 'transferToContract', {
      from: finalAccount, to: CONTRACT_NAME, symbol, quantity,
    });

    // make sure tokens are locked
    if (api.assert(transferIsSuccessful(tokenTransfer, 'transferToContract', finalAccount, CONTRACT_NAME, symbol, quantity), 'failed to transfer tokens')) {
      const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
      const timestampSec = blockDate.getTime() / 1000;

      // order
      const order = {};

      order.txId = finalTxId;
      order.timestamp = timestampSec;
      order.account = finalAccount;
      order.symbol = symbol;
      order.pair = pair;
      order.quantity = api.BigNumber(quantity).toFixed(token.precision);
      order.price = api.BigNumber(price).toFixed(pairInDb.precision);
      order.priceDec = { $numberDecimal: order.price };
      order.expiration = expiration === undefined || expiration > MAX_EXPIRATION_SECS
        ? timestampSec + MAX_EXPIRATION_SECS
        : timestampSec + expiration;

      const orderInDb = await api.db.insert('sellBook', order);

      await findMatchingBuyOrders(orderInDb, token.precision, pairInDb.precision);
    }
  }
};

actions.marketBuy = async (payload) => {
  const {
    account,
    symbol,
    pair,
    quantity,
    isSignedWithActiveKey,
  } = payload;

  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  if (!api.assert(finalAccount && typeof finalAccount === 'string' && api.isValidAccountName(finalAccount)
    && symbol && typeof symbol === 'string'
    && pair && typeof pair === 'string'
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')
  ) return;

  // get the token params
  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

  // perform a few verifications
  if (!api.assert(token, 'symbol does not exist')) return;

  const pairInDb = await api.db.findOne('pairs', { pair });

  // check if symbol is included in allowedSymbols or the pair is global
  if (!api.assert(pairInDb && (pairInDb.allowedSymbols.indexOf(symbol) !== -1 || pairInDb.allowedSymbols === true), 'pair does not exist')) return;
  if (!api.assert(countDecimals(quantity) <= pairInDb.precision
    && api.BigNumber(quantity).gt(0), 'invalid quantity')) return;

  // initiate a transfer from sender to contract balance
  // lock pair tokens
  const tokenTransfer = await api.executeSmartContract('tokens', 'transferToContract', {
    from: finalAccount, to: CONTRACT_NAME, symbol: pair, quantity,
  });

  // make sure tokens are locked
  if (api.assert(transferIsSuccessful(tokenTransfer, 'transferToContract', finalAccount, CONTRACT_NAME, pair, quantity), 'failed to transfer tokens')) {
    let pairQtyRemaining = quantity;
    let offset = 0;
    let volumeTraded = 0;

    await removeExpiredOrders('sellBook');

    // get the orders that match the symbol and the pair
    let sellOrderBook = await api.db.find('sellBook', {
      symbol,
      pair,
    }, 1000, offset,
    [
      { index: 'priceDec', descending: false },
      { index: '_id', descending: false },
    ]);

    do {
      const nbOrders = sellOrderBook.length;
      let inc = 0;

      while (inc < nbOrders && api.BigNumber(pairQtyRemaining).gt(0)) {
        const sellOrder = sellOrderBook[inc];
        const qtyTokensToSend = api.BigNumber(pairQtyRemaining)
          .dividedBy(sellOrder.price)
          .toFixed(token.precision, api.BigNumber.ROUND_DOWN);

        if (api.BigNumber(qtyTokensToSend).lte(sellOrder.quantity)
          && api.BigNumber(qtyTokensToSend).gt(0)) {
          if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
            && api.BigNumber(pairQtyRemaining).gt(0), 'the order cannot be filled')) {
            // transfer the tokens to the buyer
            await api.transferTokens(finalAccount, symbol, qtyTokensToSend, 'user');

            // transfer the tokens to the seller
            await api.transferTokens(sellOrder.account, pair, pairQtyRemaining, 'user');

            // update the sell order
            const qtyLeftSellOrder = api.BigNumber(sellOrder.quantity)
              .minus(qtyTokensToSend)
              .toFixed(token.precision);
            const nbTokensToFillOrder = api.BigNumber(sellOrder.price)
              .multipliedBy(qtyLeftSellOrder)
              .toFixed(pairInDb.precision);

            if (api.BigNumber(qtyLeftSellOrder).gt(0)
              && (api.BigNumber(nbTokensToFillOrder).gte('0.00000001'))) {
              sellOrder.quantity = qtyLeftSellOrder;

              await api.db.update('sellBook', sellOrder);
            } else {
              if (api.BigNumber(qtyLeftSellOrder).gt(0)) {
                // transfer remaining tokens to seller since the order can no longer be filled
                await api.transferTokens(sellOrder.account, symbol, qtyLeftSellOrder, 'user');
              }

              // remove the sell order
              api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });
              await api.db.remove('sellBook', sellOrder);
            }

            // add the trade to the history
            await updateTradesHistory('buy', finalAccount, sellOrder.account, symbol, pair, pairInDb.precision, qtyTokensToSend, sellOrder.price, pairQtyRemaining, api.transactionId, sellOrder.txId);

            // update the volume
            volumeTraded = api.BigNumber(volumeTraded).plus(pairQtyRemaining);

            // set quantity to zero to stop the loop
            pairQtyRemaining = '0';
          }
        } else if (api.BigNumber(qtyTokensToSend).gt(0)) {
          let qtyPairToSend = api.BigNumber(sellOrder.price)
            .multipliedBy(sellOrder.quantity)
            .toFixed(pairInDb.precision);

          if (api.BigNumber(qtyPairToSend).gt(pairQtyRemaining)) {
            qtyPairToSend = api.BigNumber(sellOrder.price)
              .multipliedBy(sellOrder.quantity)
              .toFixed(pairInDb.precision, api.BigNumber.ROUND_DOWN);
          }

          if (api.assert(api.BigNumber(qtyPairToSend).gt(0)
            && api.BigNumber(pairQtyRemaining).gt(0), 'the order cannot be filled')) {
            // transfer the tokens to the buyer
            await api.transferTokens(finalAccount, symbol, sellOrder.quantity, 'user');

            // transfer the tokens to the seller
            await api.transferTokens(sellOrder.account, pair, qtyPairToSend, 'user');

            // remove the sell order
            api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });
            await api.db.remove('sellBook', sellOrder);

            // update tokensLocked and the quantity to get
            pairQtyRemaining = api.BigNumber(pairQtyRemaining)
              .minus(qtyPairToSend)
              .toFixed(pairInDb.precision);

            // add the trade to the history
            await updateTradesHistory('buy', finalAccount, sellOrder.account, symbol, pair, pairInDb.precision, sellOrder.quantity, sellOrder.price, qtyPairToSend, api.transactionId, sellOrder.txId);

            // update the volume
            volumeTraded = api.BigNumber(volumeTraded).plus(qtyPairToSend);
          }
        }

        inc += 1;
      }

      offset += 1000;

      if (api.BigNumber(pairQtyRemaining).gt(0)) {
        // get the orders that match the symbol and the price
        sellOrderBook = await api.db.find('sellBook', {
          symbol,
          pair,
        }, 1000, offset,
        [
          { index: 'priceDec', descending: false },
          { index: '_id', descending: false },
        ]);
      }
    } while (sellOrderBook.length > 0 && api.BigNumber(pairQtyRemaining).gt(0));

    // return the tokens if the buy order is not filled
    if (api.BigNumber(pairQtyRemaining).gt(0)) {
      await api.transferTokens(finalAccount, pair, pairQtyRemaining, 'user');
    }

    // update the volume and metrics
    if (api.BigNumber(volumeTraded).gt(0)) {
      await updateVolumeMetric(symbol, pair, pairInDb.precision, volumeTraded);
    }
    await updateAskMetric(symbol, pair);
    await updateBidMetric(symbol, pair);
  }
};

actions.marketSell = async (payload) => {
  const {
    account,
    symbol,
    pair,
    quantity,
    isSignedWithActiveKey,
  } = payload;

  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  if (!api.assert(finalAccount && typeof finalAccount === 'string' && api.isValidAccountName(finalAccount)
    && symbol && typeof symbol === 'string'
    && pair && typeof pair === 'string'
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')
  ) return;

  // get the token params
  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

  // perform a few verifications
  if (!api.assert(token, 'symbol does not exist')) return;

  const pairInDb = await api.db.findOne('pairs', { pair });

  // check if symbol is included in allowedSymbols or the pair is global
  if (!api.assert(pairInDb && (pairInDb.allowedSymbols.indexOf(symbol) !== -1 || pairInDb.allowedSymbols === true), 'pair does not exist')) return;
  if (!api.assert(countDecimals(quantity) <= token.precision
    && api.BigNumber(quantity).gt(0), 'invalid quantity')) return;

  // initiate a transfer from sender to contract balance
  // lock symbol tokens
  const tokenTransfer = await api.executeSmartContract('tokens', 'transferToContract', {
    from: finalAccount, to: CONTRACT_NAME, symbol, quantity,
  });

  // make sure tokens are locked
  if (api.assert(transferIsSuccessful(tokenTransfer, 'transferToContract', finalAccount, CONTRACT_NAME, symbol, quantity), 'failed to transfer tokens')) {
    let tokensRemaining = quantity;
    let offset = 0;
    let volumeTraded = 0;

    await removeExpiredOrders('buyBook');

    // get the orders that match the symbol
    let buyOrderBook = await api.db.find('buyBook', {
      symbol,
      pair,
    }, 1000, offset,
    [
      { index: 'priceDec', descending: true },
      { index: '_id', descending: false },
    ]);

    do {
      const nbOrders = buyOrderBook.length;
      let inc = 0;

      while (inc < nbOrders && api.BigNumber(tokensRemaining).gt(0)) {
        const buyOrder = buyOrderBook[inc];
        if (api.BigNumber(tokensRemaining).lte(buyOrder.quantity)) {
          let qtyTokensToSend = api.BigNumber(buyOrder.price)
            .multipliedBy(tokensRemaining)
            .toFixed(pairInDb.precision);

          if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
            qtyTokensToSend = api.BigNumber(buyOrder.price)
              .multipliedBy(tokensRemaining)
              .toFixed(pairInDb.precision, api.BigNumber.ROUND_DOWN);
          }

          if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
            && api.BigNumber(tokensRemaining).gt(0), 'the order cannot be filled')) {
            // transfer the tokens to the buyer
            await api.transferTokens(buyOrder.account, symbol, tokensRemaining, 'user');

            // transfer the tokens to the seller
            await api.transferTokens(finalAccount, pair, qtyTokensToSend, 'user');

            // update the buy order
            const qtyLeftBuyOrder = api.BigNumber(buyOrder.quantity)
              .minus(tokensRemaining)
              .toFixed(token.precision);

            const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
              .minus(qtyTokensToSend)
              .toFixed(pairInDb.precision);
            const nbTokensToFillOrder = api.BigNumber(buyOrder.price)
              .multipliedBy(qtyLeftBuyOrder)
              .toFixed(pairInDb.precision);

            if (api.BigNumber(qtyLeftBuyOrder).gt(0)
              && (api.BigNumber(nbTokensToFillOrder).gte('0.00000001'))) {
              buyOrder.quantity = qtyLeftBuyOrder;
              buyOrder.tokensLocked = buyOrdertokensLocked;

              await api.db.update('buyBook', buyOrder);
            } else {
              if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
                // transfer remaining tokens to buyer since the order can no longer be filled
                await api.transferTokens(buyOrder.account, pair, buyOrdertokensLocked, 'user');
              }

              // remove the sell order
              api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });
              await api.db.remove('buyBook', buyOrder);
            }

            // add the trade to the history
            await updateTradesHistory('sell', buyOrder.account, finalAccount, symbol, pair, pairInDb.precision, tokensRemaining, buyOrder.price, qtyTokensToSend, buyOrder.txId, api.transactionId);

            // update the volume
            volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);

            tokensRemaining = 0;
          }
        } else {
          let qtyTokensToSend = api.BigNumber(buyOrder.price)
            .multipliedBy(buyOrder.quantity)
            .toFixed(pairInDb.precision);

          if (qtyTokensToSend > buyOrder.tokensLocked) {
            qtyTokensToSend = api.BigNumber(buyOrder.price)
              .multipliedBy(buyOrder.quantity)
              .toFixed(pairInDb.precision, api.BigNumber.ROUND_DOWN);
          }

          if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
            && api.BigNumber(tokensRemaining).gt(0), 'the order cannot be filled')) {
            // transfer the tokens to the buyer
            await api.transferTokens(buyOrder.account, symbol, buyOrder.quantity, 'user');

            // transfer the tokens to the seller
            await api.transferTokens(finalAccount, pair, qtyTokensToSend, 'user');

            const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
              .minus(qtyTokensToSend)
              .toFixed(pairInDb.precision);

            if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
              // transfer remaining tokens to buyer since the order can no longer be filled
              await api.transferTokens(buyOrder.account, pair, buyOrdertokensLocked, 'user');
            }

            // remove the buy order
            api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });
            await api.db.remove('buyBook', buyOrder);

            // update the quantity to get
            tokensRemaining = api.BigNumber(tokensRemaining)
              .minus(buyOrder.quantity)
              .toFixed(token.precision);

            // add the trade to the history
            await updateTradesHistory('sell', buyOrder.account, finalAccount, symbol, pair, pairInDb.precision, buyOrder.quantity, buyOrder.price, qtyTokensToSend, buyOrder.txId, api.transactionId);

            // update the volume
            volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);
          }
        }

        inc += 1;
      }

      offset += 1000;

      if (api.BigNumber(tokensRemaining).gt(0)) {
        // get the orders that match the symbol and the price
        buyOrderBook = await api.db.find('buyBook', {
          symbol,
          pair,
        }, 1000, offset,
        [
          { index: 'priceDec', descending: true },
          { index: '_id', descending: false },
        ]);
      }
    } while (buyOrderBook.length > 0 && api.BigNumber(tokensRemaining).gt(0));

    // send back the remaining tokens
    if (api.BigNumber(tokensRemaining).gt(0)) {
      await api.transferTokens(finalAccount, symbol, tokensRemaining, 'user');
    }

    if (api.BigNumber(volumeTraded).gt(0)) {
      await updateVolumeMetric(symbol, pair, pairInDb.precision, volumeTraded);
    }
    await updateAskMetric(symbol, pair);
    await updateBidMetric(symbol, pair);
  }
};