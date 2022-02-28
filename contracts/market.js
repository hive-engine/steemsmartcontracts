/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* eslint-disable object-curly-newline */
/* global actions, api */
const HIVE_PEGGED_SYMBOL = 'SWAP.HIVE';
const HIVE_PEGGED_SYMBOL_PRESICION = 8;
const CONTRACT_NAME = 'market';

const getMetric = async (symbol) => {
  let metric = await api.db.findOne('metrics', { symbol });

  if (metric === null) {
    metric = {};
    metric.symbol = symbol;
    metric.volume = '0';
    metric.volumeExpiration = 0;
    metric.lastPrice = '0';
    metric.lowestAsk = '0';
    metric.highestBid = '0';
    metric.lastDayPrice = '0';
    metric.lastDayPriceExpiration = 0;
    metric.priceChangeHive = '0';
    metric.priceChangePercent = '0';

    const newMetric = await api.db.insert('metrics', metric);
    return newMetric;
  }

  return metric;
};

const updateVolumeMetric = async (symbol, quantity, add = true) => {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;
  const metric = await getMetric(symbol);

  if (add === true) {
    if (metric.volumeExpiration < timestampSec) {
      metric.volume = '0.000';
    }
    metric.volume = api.BigNumber(metric.volume)
      .plus(quantity)
      .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);
    metric.volumeExpiration = blockDate.setUTCDate(blockDate.getUTCDate() + 1) / 1000;
  } else {
    metric.volume = api.BigNumber(metric.volume)
      .minus(quantity)
      .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);
  }

  if (api.BigNumber(metric.volume).lt(0)) {
    metric.volume = '0.000';
  }

  await api.db.update('metrics', metric);
};

const updatePriceMetrics = async (symbol, price) => {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;

  const metric = await getMetric(symbol);

  metric.lastPrice = price;

  if (metric.lastDayPriceExpiration < timestampSec) {
    metric.lastDayPrice = price;
    metric.lastDayPriceExpiration = blockDate.setUTCDate(blockDate.getUTCDate() + 1) / 1000;
    metric.priceChangeHive = '0';
    metric.priceChangePercent = '0%';
  } else {
    metric.priceChangeHive = api.BigNumber(price)
      .minus(metric.lastDayPrice)
      .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);
    metric.priceChangePercent = `${api.BigNumber(metric.priceChangeHive).dividedBy(metric.lastDayPrice).multipliedBy(100).toFixed(2)}%`;
  }

  await api.db.update('metrics', metric);
};

const updateBidMetric = async (symbol) => {
  const metric = await getMetric(symbol);

  const buyOrderBook = await api.db.find('buyBook',
    {
      symbol,
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

const updateAskMetric = async (symbol) => {
  const metric = await getMetric(symbol);

  const sellOrderBook = await api.db.find('sellBook',
    {
      symbol,
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

const updateTradesHistory = async (type, buyer, seller, symbol, quantity, price, volume, buyTxId, sellTxId) => {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;
  const timestampMinus24hrs = blockDate.setUTCDate(blockDate.getUTCDate() - 1) / 1000;
  // clean history

  let tradesToDelete = await api.db.find(
    'tradesHistory',
    {
      symbol,
      timestamp: {
        $lt: timestampMinus24hrs,
      },
    },
  );
  let nbTradesToDelete = tradesToDelete.length;

  while (nbTradesToDelete > 0) {
    for (let index = 0; index < nbTradesToDelete; index += 1) {
      const trade = tradesToDelete[index];
      await updateVolumeMetric(trade.symbol, trade.volume, false);
      await api.db.remove('tradesHistory', trade);
    }
    tradesToDelete = await api.db.find(
      'tradesHistory',
      {
        symbol,
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
  newTrade.quantity = quantity;
  newTrade.price = price;
  newTrade.timestamp = timestampSec;
  newTrade.volume = volume;
  newTrade.buyTxId = buyTxId;
  newTrade.sellTxId = sellTxId;
  await api.db.insert('tradesHistory', newTrade);
  await updatePriceMetrics(symbol, price);
};

const countDecimals = value => api.BigNumber(value).dp();

const removeExpiredOrders = async (table) => {
  const timestampSec = api.BigNumber(new Date(`${api.hiveBlockTimestamp}.000Z`).getTime())
    .dividedBy(1000)
    .toNumber();

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
        symbol = HIVE_PEGGED_SYMBOL;
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

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('buyBook');

  if (tableExists === false) {
    await api.db.createTable('buyBook', ['symbol', 'account', 'priceDec', 'expiration', 'txId']);
    await api.db.createTable('sellBook', ['symbol', 'account', 'priceDec', 'expiration', 'txId']);
    await api.db.createTable('tradesHistory', ['symbol']);
    await api.db.createTable('metrics', ['symbol']);
  } else {
    // remove stuck LVL order
    const order = await api.db.findOne('buyBook', { txId: 'aafa6009e922f0c5435fb6d6ef8fc10fe00bab9a' });
    if (order) {
      await api.db.remove('buyBook', order);
      await updateBidMetric(order.symbol);
    }
  }
};

actions.cancel = async (payload) => {
  const { account, type, id, isSignedWithActiveKey } = payload;
  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;
  const types = ['buy', 'sell'];

  if (api.assert(isSignedWithActiveKey === true || api.sender === 'null', 'you must use a custom_json signed with your active key')
    && api.assert(type && types.includes(type)
      && id, 'invalid params')) {
    const table = type === 'buy' ? 'buyBook' : 'sellBook';

    let order = null;
    // get order
    if (typeof id === 'string' && id.length < 50) {
      order = await api.db.findOne(table, { txId: id });
    } else if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
      order = await api.db.findOne(table, { _id: id });
    }

    if (api.assert(order !== null, 'order does not exist or invalid params')
      && order.account === finalAccount) {
      let quantity;
      let symbol;

      if (type === 'buy') {
        symbol = HIVE_PEGGED_SYMBOL;
        quantity = order.tokensLocked;
      } else {
        // eslint-disable-next-line prefer-destructuring
        symbol = order.symbol;
        // eslint-disable-next-line prefer-destructuring
        quantity = order.quantity;
      }

      // unlock tokens
      await api.transferTokens(finalAccount, symbol, quantity, 'user');

      await api.db.remove(table, order);

      if (type === 'sell') {
        await updateAskMetric(order.symbol);
      } else {
        await updateBidMetric(order.symbol);
      }
    }
  }
};

const findMatchingSellOrders = async (order, tokenPrecision) => {
  const {
    account,
    symbol,
    priceDec,
  } = order;

  const buyOrder = order;
  let offset = 0;
  let volumeTraded = 0;

  await removeExpiredOrders('sellBook');

  // get the orders that match the symbol and the price
  let sellOrderBook = await api.db.find('sellBook', {
    symbol,
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
          .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

        if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
          qtyTokensToSend = api.BigNumber(sellOrder.price)
            .multipliedBy(buyOrder.quantity)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION, api.BigNumber.ROUND_DOWN);
        }

        if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
          && api.BigNumber(buyOrder.quantity).gt(0), 'the order cannot be filled')) {
          // transfer the tokens to the buyer
          let res = await api.transferTokens(account, symbol, buyOrder.quantity, 'user');

          if (res.errors) {
            api.debug(res.errors);
            api.debug(`TXID: ${buyOrder.txId}`);
            api.debug(account);
            api.debug(symbol);
            api.debug(buyOrder.quantity);
          }

          // transfer the tokens to the seller
          res = await api.transferTokens(sellOrder.account, HIVE_PEGGED_SYMBOL, qtyTokensToSend, 'user');

          if (res.errors) {
            api.debug(res.errors);
            api.debug(`TXID: ${buyOrder.txId}`);
            api.debug(sellOrder.account);
            api.debug(HIVE_PEGGED_SYMBOL);
            api.debug(qtyTokensToSend);
          }

          // update the sell order
          const qtyLeftSellOrder = api.BigNumber(sellOrder.quantity)
            .minus(buyOrder.quantity)
            .toFixed(tokenPrecision);
          const nbTokensToFillOrder = api.BigNumber(sellOrder.price)
            .multipliedBy(qtyLeftSellOrder)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

          if (api.BigNumber(qtyLeftSellOrder).gt(0)
            && (api.BigNumber(nbTokensToFillOrder).gte('0.00000001'))) {
            sellOrder.quantity = qtyLeftSellOrder;

            await api.db.update('sellBook', sellOrder);
          } else {
            if (api.BigNumber(qtyLeftSellOrder).gt(0)) {
              await api.transferTokens(sellOrder.account, symbol, qtyLeftSellOrder, 'user');
            }
            api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });
            await api.db.remove('sellBook', sellOrder);
          }

          // unlock remaining tokens, update the quantity to get and remove the buy order
          const tokensToUnlock = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

          if (api.BigNumber(tokensToUnlock).gt(0)) {
            await api.transferTokens(account, HIVE_PEGGED_SYMBOL, tokensToUnlock, 'user');
          }

          // add the trade to the history
          await updateTradesHistory('buy', account, sellOrder.account, symbol, buyOrder.quantity, sellOrder.price, qtyTokensToSend, buyOrder.txId, sellOrder.txId);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);

          buyOrder.quantity = '0';
          await api.db.remove('buyBook', buyOrder);
          api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });
        }
      } else {
        let qtyTokensToSend = api.BigNumber(sellOrder.price)
          .multipliedBy(sellOrder.quantity)
          .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

        if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
          qtyTokensToSend = api.BigNumber(sellOrder.price)
            .multipliedBy(sellOrder.quantity)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION, api.BigNumber.ROUND_DOWN);
        }

        if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
          && api.BigNumber(buyOrder.quantity).gt(0), 'the order cannot be filled')) {
          // transfer the tokens to the buyer
          let res = await api.transferTokens(account, symbol, sellOrder.quantity, 'user');

          if (res.errors) {
            api.debug(res.errors);
            api.debug(`TXID: ${buyOrder.txId}`);
            api.debug(account);
            api.debug(symbol);
            api.debug(sellOrder.quantity);
          }

          // transfer the tokens to the seller
          res = await api.transferTokens(sellOrder.account, HIVE_PEGGED_SYMBOL, qtyTokensToSend, 'user');

          if (res.errors) {
            api.debug(res.errors);
            api.debug(`TXID: ${buyOrder.txId}`);
            api.debug(sellOrder.account);
            api.debug(HIVE_PEGGED_SYMBOL);
            api.debug(qtyTokensToSend);
          }

          // remove the sell order
          await api.db.remove('sellBook', sellOrder);
          api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });

          // update tokensLocked and the quantity to get
          buyOrder.tokensLocked = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);
          buyOrder.quantity = api.BigNumber(buyOrder.quantity)
            .minus(sellOrder.quantity)
            .toFixed(tokenPrecision);

          // check if the order can still be filled
          const nbTokensToFillOrder = api.BigNumber(buyOrder.price)
            .multipliedBy(buyOrder.quantity)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

          if (api.BigNumber(nbTokensToFillOrder).lt('0.00000001')) {
            await api.transferTokens(account, HIVE_PEGGED_SYMBOL, buyOrder.tokensLocked, 'user');

            buyOrder.quantity = '0';
            await api.db.remove('buyBook', buyOrder);
            api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });
          }

          // add the trade to the history
          await updateTradesHistory('buy', account, sellOrder.account, symbol, sellOrder.quantity, sellOrder.price, qtyTokensToSend, buyOrder.txId, sellOrder.txId);

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
  if (api.BigNumber(volumeTraded).gt(0)) {
    await updateVolumeMetric(symbol, volumeTraded);
  }
  await updateAskMetric(symbol);
  await updateBidMetric(symbol);
};

const findMatchingBuyOrders = async (order, tokenPrecision) => {
  const {
    account,
    symbol,
    priceDec,
  } = order;

  const sellOrder = order;
  let offset = 0;
  let volumeTraded = 0;

  await removeExpiredOrders('buyBook');

  // get the orders that match the symbol and the price
  let buyOrderBook = await api.db.find('buyBook', {
    symbol,
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
          .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

        if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
          qtyTokensToSend = api.BigNumber(buyOrder.price)
            .multipliedBy(sellOrder.quantity)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION, api.BigNumber.ROUND_DOWN);
        }

        if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
          && api.BigNumber(sellOrder.quantity).gt(0), 'the order cannot be filled')) {
          // transfer the tokens to the buyer
          let res = await api.transferTokens(buyOrder.account, symbol, sellOrder.quantity, 'user');

          if (res.errors) {
            api.debug(res.errors);
            api.debug(`TXID: ${sellOrder.txId}`);
            api.debug(buyOrder.account);
            api.debug(symbol);
            api.debug(sellOrder.quantity);
          }

          // transfer the tokens to the seller
          res = await api.transferTokens(account, HIVE_PEGGED_SYMBOL, qtyTokensToSend, 'user');

          if (res.errors) {
            api.debug(res.errors);
            api.debug(`TXID: ${sellOrder.txId}`);
            api.debug(account);
            api.debug(HIVE_PEGGED_SYMBOL);
            api.debug(qtyTokensToSend);
          }

          // update the buy order
          const qtyLeftBuyOrder = api.BigNumber(buyOrder.quantity)
            .minus(sellOrder.quantity)
            .toFixed(tokenPrecision);

          const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);
          const nbTokensToFillOrder = api.BigNumber(buyOrder.price)
            .multipliedBy(qtyLeftBuyOrder)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

          if (api.BigNumber(qtyLeftBuyOrder).gt(0)
            && (api.BigNumber(nbTokensToFillOrder).gte('0.00000001'))) {
            buyOrder.quantity = qtyLeftBuyOrder;
            buyOrder.tokensLocked = buyOrdertokensLocked;

            await api.db.update('buyBook', buyOrder);
          } else {
            if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
              await api.transferTokens(buyOrder.account, HIVE_PEGGED_SYMBOL, buyOrdertokensLocked, 'user');
            }
            api.emit('orderClosed', { account: buyOrder.account, type: 'buy', txId: buyOrder.txId });
            await api.db.remove('buyBook', buyOrder);
          }

          // add the trade to the history
          await updateTradesHistory('sell', buyOrder.account, account, symbol, sellOrder.quantity, buyOrder.price, qtyTokensToSend, buyOrder.txId, sellOrder.txId);

          // update the volume
          volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);

          sellOrder.quantity = 0;
          await api.db.remove('sellBook', sellOrder);
          api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });
        }
      } else {
        let qtyTokensToSend = api.BigNumber(buyOrder.price)
          .multipliedBy(buyOrder.quantity)
          .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

        if (qtyTokensToSend > buyOrder.tokensLocked) {
          qtyTokensToSend = api.BigNumber(buyOrder.price)
            .multipliedBy(buyOrder.quantity)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION, api.BigNumber.ROUND_DOWN);
        }

        if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
          && api.BigNumber(sellOrder.quantity).gt(0), 'the order cannot be filled')) {
          // transfer the tokens to the buyer
          let res = await api.transferTokens(buyOrder.account, symbol, buyOrder.quantity, 'user');

          if (res.errors) {
            api.debug(res.errors);
            api.debug(`TXID: ${sellOrder.txId}`);
            api.debug(buyOrder.account);
            api.debug(symbol);
            api.debug(buyOrder.quantity);
          }

          // transfer the tokens to the seller
          res = await api.transferTokens(account, HIVE_PEGGED_SYMBOL, qtyTokensToSend, 'user');

          if (res.errors) {
            api.debug(res.errors);
            api.debug(`TXID: ${sellOrder.txId}`);
            api.debug(account);
            api.debug(HIVE_PEGGED_SYMBOL);
            api.debug(qtyTokensToSend);
          }

          const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
            .minus(qtyTokensToSend)
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

          if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
            await api.transferTokens(buyOrder.account, HIVE_PEGGED_SYMBOL, buyOrdertokensLocked, 'user');
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
            .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

          if (api.BigNumber(nbTokensToFillOrder).lt('0.00000001')) {
            await api.transferTokens(account, symbol, sellOrder.quantity, 'user');

            sellOrder.quantity = '0';
            await api.db.remove('sellBook', sellOrder);
            api.emit('orderClosed', { account: sellOrder.account, type: 'sell', txId: sellOrder.txId });
          }

          // add the trade to the history
          await updateTradesHistory('sell', buyOrder.account, account, symbol, buyOrder.quantity, buyOrder.price, qtyTokensToSend, buyOrder.txId, sellOrder.txId);

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
    await updateVolumeMetric(symbol, volumeTraded);
  }
  await updateAskMetric(symbol);
  await updateBidMetric(symbol);
};

actions.buy = async (payload) => {
  const {
    account,
    txId,
    symbol,
    quantity,
    price,
    expiration,
    isSignedWithActiveKey,
  } = payload;

  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;
  const finalTxId = (txId === undefined || api.sender !== 'null') ? api.transactionId : txId;

  // buy (quantity) of (symbol) at (price)(HIVE_PEGGED_SYMBOL) per (symbol)
  if (api.assert(isSignedWithActiveKey === true || api.sender === 'null', 'you must use a custom_json signed with your active key')
    && api.assert(price && typeof price === 'string' && !api.BigNumber(price).isNaN()
      && symbol && typeof symbol === 'string' && symbol !== HIVE_PEGGED_SYMBOL
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN()
      && finalTxId && typeof finalTxId === 'string' && finalTxId.length > 0
      && (expiration === undefined || (expiration && Number.isInteger(expiration) && expiration > 0)), 'invalid params')
  ) {
    // get the token params
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

    // perform a few verifications
    if (api.assert(token
      && api.BigNumber(price).gt(0)
      && countDecimals(price) <= HIVE_PEGGED_SYMBOL_PRESICION
      && countDecimals(quantity) <= token.precision, 'invalid params')) {
      // initiate a transfer from sender to contract balance

      const nbTokensToLock = api.BigNumber(price)
        .multipliedBy(quantity)
        .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

      if (api.assert(api.BigNumber(nbTokensToLock).gte('0.00000001'), 'order cannot be placed as it cannot be filled')) {
        // lock HIVE_PEGGED_SYMBOL tokens
        const res = await api.executeSmartContract('tokens', 'transferToContract', { from: finalAccount, symbol: HIVE_PEGGED_SYMBOL, quantity: nbTokensToLock, to: CONTRACT_NAME });

        if (res.errors === undefined
          && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === finalAccount && el.data.to === CONTRACT_NAME && el.data.quantity === nbTokensToLock && el.data.symbol === HIVE_PEGGED_SYMBOL) !== undefined) {
          const timestampSec = api.BigNumber(new Date(`${api.hiveBlockTimestamp}.000Z`).getTime())
            .dividedBy(1000)
            .toNumber();

          // order
          const order = {};

          order.txId = finalTxId;
          order.timestamp = timestampSec;
          order.account = finalAccount;
          order.symbol = symbol;
          order.quantity = api.BigNumber(quantity).toFixed(token.precision);
          order.price = api.BigNumber(price).toFixed(HIVE_PEGGED_SYMBOL_PRESICION);
          order.priceDec = { $numberDecimal: order.price };
          order.tokensLocked = nbTokensToLock;
          order.expiration = expiration === undefined || expiration > 2592000
            ? timestampSec + 2592000
            : timestampSec + expiration;

          const orderInDb = await api.db.insert('buyBook', order);

          await findMatchingSellOrders(orderInDb, token.precision);
        }
      }
    }
  }
};

actions.sell = async (payload) => {
  const {
    account,
    txId,
    symbol,
    quantity,
    price,
    expiration,
    isSignedWithActiveKey,
  } = payload;

  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;
  const finalTxId = (txId === undefined || api.sender !== 'null') ? api.transactionId : txId;

  // sell (quantity) of (symbol) at (price)(HIVE_PEGGED_SYMBOL) per (symbol)
  if (api.assert(isSignedWithActiveKey === true || api.sender === 'null', 'you must use a custom_json signed with your active key')
    && api.assert(price && typeof price === 'string' && !api.BigNumber(price).isNaN()
      && symbol && typeof symbol === 'string' && symbol !== HIVE_PEGGED_SYMBOL
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN()
      && finalTxId && typeof finalTxId === 'string' && finalTxId.length > 0
      && (expiration === undefined || (expiration && Number.isInteger(expiration) && expiration > 0)), 'invalid params')) {
    // get the token params
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

    // perform a few verifications
    if (api.assert(token
      && api.BigNumber(price).gt(0)
      && countDecimals(price) <= HIVE_PEGGED_SYMBOL_PRESICION
      && countDecimals(quantity) <= token.precision, 'invalid params')) {
      const nbTokensToFillOrder = api.BigNumber(price)
        .multipliedBy(quantity)
        .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

      if (api.assert(api.BigNumber(nbTokensToFillOrder).gte('0.00000001'), 'order cannot be placed as it cannot be filled')) {
        // initiate a transfer from sender to contract balance
        // lock symbol tokens
        const res = await api.executeSmartContract('tokens', 'transferToContract', { from: finalAccount, symbol, quantity, to: CONTRACT_NAME });

        if (res.errors === undefined
          && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === finalAccount && el.data.to === CONTRACT_NAME && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
          const timestampSec = api.BigNumber(new Date(`${api.hiveBlockTimestamp}.000Z`).getTime())
            .dividedBy(1000)
            .toNumber();

          // order
          const order = {};

          order.txId = finalTxId;
          order.timestamp = timestampSec;
          order.account = finalAccount;
          order.symbol = symbol;
          order.quantity = api.BigNumber(quantity).toFixed(token.precision);
          order.price = api.BigNumber(price).toFixed(HIVE_PEGGED_SYMBOL_PRESICION);
          order.priceDec = { $numberDecimal: order.price };
          order.expiration = expiration === undefined || expiration > 2592000
            ? timestampSec + 2592000
            : timestampSec + expiration;

          const orderInDb = await api.db.insert('sellBook', order);

          await findMatchingBuyOrders(orderInDb, token.precision);
        }
      }
    }
  }
};

actions.marketBuy = async (payload) => {
  const {
    account,
    symbol,
    quantity,
    isSignedWithActiveKey,
  } = payload;

  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;

  if (api.assert(isSignedWithActiveKey === true || api.sender === 'null', 'you must use a custom_json signed with your active key')
    && symbol && typeof symbol === 'string' && symbol !== HIVE_PEGGED_SYMBOL
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN() && api.BigNumber(quantity).gt(0)) {
    // get the token params
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

    // perform a few verifications
    if (api.assert(token
      && countDecimals(quantity) <= HIVE_PEGGED_SYMBOL_PRESICION, 'invalid params')) {
      // initiate a transfer from sender to contract balance
      // lock HIVE_PEGGED_SYMBOL tokens
      const result = await api.executeSmartContract('tokens', 'transferToContract', { from: finalAccount, symbol: HIVE_PEGGED_SYMBOL, quantity, to: CONTRACT_NAME });

      if (result.errors === undefined
        && result.events && result.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === finalAccount && el.data.to === CONTRACT_NAME && el.data.quantity === quantity && el.data.symbol === HIVE_PEGGED_SYMBOL) !== undefined) {
        let hiveRemaining = quantity;
        let offset = 0;
        let volumeTraded = 0;

        await removeExpiredOrders('sellBook');

        // get the orders that match the symbol and the price
        let sellOrderBook = await api.db.find('sellBook', {
          symbol,
        }, 1000, offset,
        [
          { index: 'priceDec', descending: false },
          { index: '_id', descending: false },
        ]);

        do {
          const nbOrders = sellOrderBook.length;
          let inc = 0;

          while (inc < nbOrders && api.BigNumber(hiveRemaining).gt(0)) {
            const sellOrder = sellOrderBook[inc];
            const qtyTokensToSend = api.BigNumber(hiveRemaining)
              .dividedBy(sellOrder.price)
              .toFixed(token.precision, api.BigNumber.ROUND_DOWN);

            if (api.BigNumber(qtyTokensToSend).lte(sellOrder.quantity)
              && api.BigNumber(qtyTokensToSend).gt(0)) {
              if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
                && api.BigNumber(hiveRemaining).gt(0), 'the order cannot be filled')) {
                // transfer the tokens to the buyer
                let res = await api.transferTokens(finalAccount, symbol, qtyTokensToSend, 'user');

                if (res.errors) {
                  api.debug(res.errors);
                  api.debug(`TXID: ${api.transactionId}`);
                  api.debug(finalAccount);
                  api.debug(symbol);
                  api.debug(qtyTokensToSend);
                }

                // transfer the tokens to the seller
                res = await api.transferTokens(sellOrder.account, HIVE_PEGGED_SYMBOL, hiveRemaining, 'user');

                if (res.errors) {
                  api.debug(res.errors);
                  api.debug(`TXID: ${api.transactionId}`);
                  api.debug(sellOrder.account);
                  api.debug(HIVE_PEGGED_SYMBOL);
                  api.debug(hiveRemaining);
                }

                // update the sell order
                const qtyLeftSellOrder = api.BigNumber(sellOrder.quantity)
                  .minus(qtyTokensToSend)
                  .toFixed(token.precision);
                const nbTokensToFillOrder = api.BigNumber(sellOrder.price)
                  .multipliedBy(qtyLeftSellOrder)
                  .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

                if (api.BigNumber(qtyLeftSellOrder).gt(0)
                  && (api.BigNumber(nbTokensToFillOrder).gte('0.00000001'))) {
                  sellOrder.quantity = qtyLeftSellOrder;

                  await api.db.update('sellBook', sellOrder);
                } else {
                  if (api.BigNumber(qtyLeftSellOrder).gt(0)) {
                    await api.transferTokens(sellOrder.account, symbol, qtyLeftSellOrder, 'user');
                  }
                  await api.db.remove('sellBook', sellOrder);
                }

                // add the trade to the history
                await updateTradesHistory('buy', finalAccount, sellOrder.account, symbol, qtyTokensToSend, sellOrder.price, hiveRemaining, api.transactionId, sellOrder.txId);

                // update the volume
                volumeTraded = api.BigNumber(volumeTraded).plus(hiveRemaining);

                hiveRemaining = '0';
              }
            } else if (api.BigNumber(qtyTokensToSend).gt(0)) {
              let qtyHiveToSend = api.BigNumber(sellOrder.price)
                .multipliedBy(sellOrder.quantity)
                .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

              if (api.BigNumber(qtyHiveToSend).gt(hiveRemaining)) {
                qtyHiveToSend = api.BigNumber(sellOrder.price)
                  .multipliedBy(sellOrder.quantity)
                  .toFixed(HIVE_PEGGED_SYMBOL_PRESICION, api.BigNumber.ROUND_DOWN);
              }

              if (api.assert(api.BigNumber(qtyHiveToSend).gt(0)
                && api.BigNumber(hiveRemaining).gt(0), 'the order cannot be filled')) {
                // transfer the tokens to the buyer
                let res = await api.transferTokens(finalAccount, symbol, sellOrder.quantity, 'user');

                if (res.errors) {
                  api.debug(res.errors);
                  api.debug(`TXID: ${api.transactionId}`);
                  api.debug(finalAccount);
                  api.debug(symbol);
                  api.debug(sellOrder.quantity);
                }

                // transfer the tokens to the seller
                res = await api.transferTokens(sellOrder.account, HIVE_PEGGED_SYMBOL, qtyHiveToSend, 'user');

                if (res.errors) {
                  api.debug(res.errors);
                  api.debug(`TXID: ${api.transactionId}`);
                  api.debug(sellOrder.account);
                  api.debug(HIVE_PEGGED_SYMBOL);
                  api.debug(qtyHiveToSend);
                }

                // remove the sell order
                await api.db.remove('sellBook', sellOrder);

                // update tokensLocked and the quantity to get
                hiveRemaining = api.BigNumber(hiveRemaining)
                  .minus(qtyHiveToSend)
                  .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

                // add the trade to the history
                await updateTradesHistory('buy', finalAccount, sellOrder.account, symbol, sellOrder.quantity, sellOrder.price, qtyHiveToSend, api.transactionId, sellOrder.txId);

                // update the volume
                volumeTraded = api.BigNumber(volumeTraded).plus(qtyHiveToSend);
              }
            }

            inc += 1;
          }

          offset += 1000;

          if (api.BigNumber(hiveRemaining).gt(0)) {
            // get the orders that match the symbol and the price
            sellOrderBook = await api.db.find('sellBook', {
              symbol,
            }, 1000, offset,
            [
              { index: 'priceDec', descending: false },
              { index: '_id', descending: false },
            ]);
          }
        } while (sellOrderBook.length > 0 && api.BigNumber(hiveRemaining).gt(0));

        // update the buy order if partially filled
        if (api.BigNumber(hiveRemaining).gt(0)) {
          await api.transferTokens(finalAccount, HIVE_PEGGED_SYMBOL, hiveRemaining, 'user');
        }
        if (api.BigNumber(volumeTraded).gt(0)) {
          await updateVolumeMetric(symbol, volumeTraded);
        }
        await updateAskMetric(symbol);
        await updateBidMetric(symbol);
      }
    }
  }
};

actions.marketSell = async (payload) => {
  const {
    account,
    symbol,
    quantity,
    isSignedWithActiveKey,
  } = payload;

  const finalAccount = (account === undefined || api.sender !== 'null') ? api.sender : account;

  if (api.assert(isSignedWithActiveKey === true || api.sender === 'null', 'you must use a custom_json signed with your active key')
    && symbol && typeof symbol === 'string' && symbol !== HIVE_PEGGED_SYMBOL
    && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN() && api.BigNumber(quantity).gt(0)) {
    // get the token params
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

    // perform a few verifications
    if (api.assert(token
      && countDecimals(quantity) <= token.precision, 'invalid params')) {
      // initiate a transfer from sender to contract balance
      // lock symbol tokens
      const result = await api.executeSmartContract('tokens', 'transferToContract', { from: finalAccount, symbol, quantity, to: CONTRACT_NAME });

      if (result.errors === undefined
        && result.events && result.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === finalAccount && el.data.to === CONTRACT_NAME && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
        let tokensRemaining = quantity;
        let offset = 0;
        let volumeTraded = 0;

        await removeExpiredOrders('buyBook');

        // get the orders that match the symbol
        let buyOrderBook = await api.db.find('buyBook', {
          symbol,
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
                .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

              if (api.BigNumber(qtyTokensToSend).gt(buyOrder.tokensLocked)) {
                qtyTokensToSend = api.BigNumber(buyOrder.price)
                  .multipliedBy(tokensRemaining)
                  .toFixed(HIVE_PEGGED_SYMBOL_PRESICION, api.BigNumber.ROUND_DOWN);
              }

              if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
                && api.BigNumber(tokensRemaining).gt(0), 'the order cannot be filled')) {
                // transfer the tokens to the buyer
                let res = await api.transferTokens(buyOrder.account, symbol, tokensRemaining, 'user');

                if (res.errors) {
                  api.debug(res.errors);
                  api.debug(`TXID: ${api.transactionId}`);
                  api.debug(buyOrder.account);
                  api.debug(symbol);
                  api.debug(tokensRemaining);
                }

                // transfer the tokens to the seller
                res = await api.transferTokens(finalAccount, HIVE_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                if (res.errors) {
                  api.debug(res.errors);
                  api.debug(`TXID: ${api.transactionId}`);
                  api.debug(finalAccount);
                  api.debug(HIVE_PEGGED_SYMBOL);
                  api.debug(qtyTokensToSend);
                }

                // update the buy order
                const qtyLeftBuyOrder = api.BigNumber(buyOrder.quantity)
                  .minus(tokensRemaining)
                  .toFixed(token.precision);

                const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
                  .minus(qtyTokensToSend)
                  .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);
                const nbTokensToFillOrder = api.BigNumber(buyOrder.price)
                  .multipliedBy(qtyLeftBuyOrder)
                  .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

                if (api.BigNumber(qtyLeftBuyOrder).gt(0)
                  && (api.BigNumber(nbTokensToFillOrder).gte('0.00000001'))) {
                  buyOrder.quantity = qtyLeftBuyOrder;
                  buyOrder.tokensLocked = buyOrdertokensLocked;

                  await api.db.update('buyBook', buyOrder);
                } else {
                  if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
                    await api.transferTokens(buyOrder.account, HIVE_PEGGED_SYMBOL, buyOrdertokensLocked, 'user');
                  }
                  await api.db.remove('buyBook', buyOrder);
                }

                // add the trade to the history
                await updateTradesHistory('sell', buyOrder.account, finalAccount, symbol, tokensRemaining, buyOrder.price, qtyTokensToSend, buyOrder.txId, api.transactionId);

                // update the volume
                volumeTraded = api.BigNumber(volumeTraded).plus(qtyTokensToSend);

                tokensRemaining = 0;
              }
            } else {
              let qtyTokensToSend = api.BigNumber(buyOrder.price)
                .multipliedBy(buyOrder.quantity)
                .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

              if (qtyTokensToSend > buyOrder.tokensLocked) {
                qtyTokensToSend = api.BigNumber(buyOrder.price)
                  .multipliedBy(buyOrder.quantity)
                  .toFixed(HIVE_PEGGED_SYMBOL_PRESICION, api.BigNumber.ROUND_DOWN);
              }

              if (api.assert(api.BigNumber(qtyTokensToSend).gt(0)
                && api.BigNumber(tokensRemaining).gt(0), 'the order cannot be filled')) {
                // transfer the tokens to the buyer
                let res = await api.transferTokens(buyOrder.account, symbol, buyOrder.quantity, 'user');

                if (res.errors) {
                  api.debug(res.errors);
                  api.debug(`TXID: ${api.transactionId}`);
                  api.debug(buyOrder.account);
                  api.debug(symbol);
                  api.debug(buyOrder.quantity);
                }

                // transfer the tokens to the seller
                res = await api.transferTokens(finalAccount, HIVE_PEGGED_SYMBOL, qtyTokensToSend, 'user');

                if (res.errors) {
                  api.debug(res.errors);
                  api.debug(`TXID: ${api.transactionId}`);
                  api.debug(finalAccount);
                  api.debug(HIVE_PEGGED_SYMBOL);
                  api.debug(qtyTokensToSend);
                }

                const buyOrdertokensLocked = api.BigNumber(buyOrder.tokensLocked)
                  .minus(qtyTokensToSend)
                  .toFixed(HIVE_PEGGED_SYMBOL_PRESICION);

                if (api.BigNumber(buyOrdertokensLocked).gt(0)) {
                  await api.transferTokens(buyOrder.account, HIVE_PEGGED_SYMBOL, buyOrdertokensLocked, 'user');
                }

                // remove the buy order
                await api.db.remove('buyBook', buyOrder);

                // update the quantity to get
                tokensRemaining = api.BigNumber(tokensRemaining)
                  .minus(buyOrder.quantity)
                  .toFixed(token.precision);

                // add the trade to the history
                await updateTradesHistory('sell', buyOrder.account, finalAccount, symbol, buyOrder.quantity, buyOrder.price, qtyTokensToSend, buyOrder.txId, api.transactionId);

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
          await updateVolumeMetric(symbol, volumeTraded);
        }
        await updateAskMetric(symbol);
        await updateBidMetric(symbol);
      }
    }
  }
};
