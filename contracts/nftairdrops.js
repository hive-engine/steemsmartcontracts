/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'nftairdrops';

/* eslint-disable no-template-curly-in-string */
// const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
// const UTILITY_TOKEN_PRECISION = "'${CONSTANTS.UTILITY_TOKEN_PRECISION}$'";
/* eslint-enable no-template-curly-in-string */


// BEGIN helper functions

// END helper functions

// BEGIN contract actions

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pendingAirdrops');
  if (tableExists === false) {
    await api.db.createTable('pendingAirdrops', ['airdropId', 'symbol']);
    await api.db.createTable('params');

    const params = {};
    params.feePerTransaction = '0.1';
    params.maxTransactionsPerAirdrop = 50000;
    params.maxTransactionsPerBlock = 50;
    params.maxAirdropsPerBlock = 1;
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      feePerTransaction,
      maxTransactionsPerAirdrop,
      maxTransactionsPerBlock,
      maxAirdropsPerBlock,
    } = payload;

    const params = await api.db.findOne('params', {});

    if (feePerTransaction) {
      if (api.assert(typeof feePerTransaction === 'string' && !api.BigNumber(feePerTransaction).isNaN() && api.BigNumber(feePerTransaction).gte(0), 'invalid feePerTransaction')) {
        params.feePerTransaction = feePerTransaction;
      }
    }
    if (maxTransactionsPerAirdrop) {
      if (api.assert(Number.isInteger(maxTransactionsPerAirdrop) && maxTransactionsPerAirdrop > 0, 'invalid maxTransactionsPerAirdrop')) {
        params.maxTransactionsPerAirdrop = maxTransactionsPerAirdrop;
      }
    }
    if (maxTransactionsPerBlock) {
      if (api.assert(Number.isInteger(maxTransactionsPerBlock) && maxTransactionsPerBlock > 0, 'invalid maxTransactionsPerBlock')) {
        params.maxTransactionsPerBlock = maxTransactionsPerBlock;
      }
    }
    if (maxAirdropsPerBlock) {
      if (api.assert(Number.isInteger(maxAirdropsPerBlock) && maxAirdropsPerBlock > 0, 'invalid maxAirdropsPerBlock')) {
        params.maxAirdropsPerBlock = maxAirdropsPerBlock;
      }
    }

    await api.db.update('params', params);
  }
};

// END contract actions
