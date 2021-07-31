/* eslint-disable no-await-in-loop */
/* global actions, api */

const UTILITY_TOKEN_SYMBOL = 'BEE';

const CONTRACT_NAME = 'dmarket';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('params');

  if (tableExists === false) {
    await api.db.createTable('params');
    await api.db.createTable('pairs', ['symbol', 'precision', 'allowedSymbols']);
    await api.db.createTable('buyBook', ['symbol', 'pair', 'account', 'priceDec', 'expiration', 'txId']);
    await api.db.createTable('sellBook', ['symbol', 'pair', 'account', 'priceDec', 'expiration', 'txId']);
    await api.db.createTable('tradesHistory', ['symbol', 'pair']);
    await api.db.createTable('metrics', ['symbol', 'pair']);

    const params = {};
    params.pairCreationFee = '500';

    // default global pairs
    const pairs = [
      {
        pair: 'BEE',
        precision: 8,
        allowedSymbols: true // true - all tokens are allowed
      },
      {
        pair: 'SWAP.BTC',
        precision: 8,
        allowedSymbols: true // true - all tokens are allowed
      },
    ];

    await api.db.insert('params', params);

    for (let i = 0; i < pairs.length; i++) {
      await api.db.insert('pairs', pairs[i]);
    }
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      pairCreationFee,
    } = payload;

    const params = await api.db.findOne('params', {});

    if (pairCreationFee) {
      if (!api.assert(typeof pairCreationFee === 'string' && api.BigNumber(pairCreationFee).isFinite() && api.BigNumber(pairCreationFee).gte(0), 'invalid pairCreationFee')) return;
      params.pairCreationFee = pairCreationFee;
    }

    await api.db.update('params', params);
  }
};

actions.addPair = async (payload) => {
  const {
    pair,
    symbol,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(pair && typeof pair === 'string', 'invalid pair')) return;
  if (!api.assert(symbol && typeof symbol === 'string', 'invalid symbol')) return;
  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
  if (!api.assert(token, 'symbol does not exist')) return;

  const pair = await api.db.findOne('pairs', { pair });

  if (pair) {
    if (api.assert(pair.allowedSymbols.indexOf(symbol) === -1, 'symbol is already in the pair')) {
      pair.allowedSymbols.push(symbol);
    }

    // add the new symbol in the pair
    await api.db.update('pairs', pair);
  } else {
    const pairToken = await api.db.findOneInTable('tokens', 'tokens', { pair });
    if (!api.assert(pairToken, 'pair symbol does not exist')) return;

    // add new pair in the db
    await api.db.insert('pairs', {
        pair,
        precision: pairToken.precision,
        allowedSymbols: [symbol],
    });
  }

  api.emit('addPair', {
    pair,
    symbol,
  });
};

actions.addGlobalPair = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      pair,
    } = payload;

    if (!api.assert(pair && typeof pair === 'string', 'invalid pair')) return;

    const pair = await api.db.findOne('pairs', { pair });

    if (pair) {
      if (api.assert(pair.allowedSymbols === true, 'pair is already global')) {
        pair.allowedSymbols = true;
      }

      // update the pair as global
      await api.db.update('pairs', pair);
    } else {
      const pairToken = await api.db.findOneInTable('tokens', 'tokens', { pair });
      if (!api.assert(pairToken, 'pair symbol does not exist')) return;

      // add new global pair
      await api.db.insert('pairs', {
          pair,
          precision: pairToken.precision,
          allowedSymbols: true,
      });
    }

    api.emit('addGlobalPair', {
      pair,
    });
  }
};
