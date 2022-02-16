/* eslint-disable no-await-in-loop */
/* global actions, api */

const UTILITY_TOKEN_SYMBOL = 'BEE';
const UTILITY_TOKEN_PRECISION = 8;
const CONTRACT_NAME = 'nftairdrops';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pendingNftAirdrops');
  if (tableExists === false) {
    await api.db.createTable('pendingNftAirdrops', ['nftAirdropId', 'symbol']);
    await api.db.createTable('params');

    const params = {};
    params.feePerTransaction = '0.1';
    params.maxTransactionsPerBlock = 50;
    params.maxAirdropsPerBlock = 1;
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      feePerTransaction,
      maxTransactionsPerBlock,
      maxAirdropsPerBlock,
    } = payload;

    const params = await api.db.findOne('params', {});

    if (feePerTransaction) {
      if (!api.assert(typeof feePerTransaction === 'string' && !api.BigNumber(feePerTransaction).isNaN() && api.BigNumber(feePerTransaction).gte(0), 'invalid feePerTransaction')) return;
      params.feePerTransaction = feePerTransaction;
    }
    if (maxTransactionsPerBlock) {
      if (!api.assert(Number.isInteger(maxTransactionsPerBlock) && maxTransactionsPerBlock >= 1, 'invalid maxTransactionsPerBlock')) return;
      params.maxTransactionsPerBlock = maxTransactionsPerBlock;
    }
    if (maxAirdropsPerBlock) {
      if (!api.assert(Number.isInteger(maxAirdropsPerBlock) && maxAirdropsPerBlock >= 1, 'invalid maxAirdropsPerBlock')) return;
      params.maxAirdropsPerBlock = maxAirdropsPerBlock;
    }

    await api.db.update('params', params);
  }
};

actions.newAirdrop = async (payload) => {
  const {
    symbol,
    list,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
    && list && Array.isArray(list), 'invalid params')) {
  }
};
