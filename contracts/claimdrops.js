/* eslint-disable no-await-in-loop */
/* global actions, api */

const UTILITY_TOKEN_SYMBOL = 'BEE';
const CONTRACT_NAME = 'claimdrops';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('claimdrops');
  if (tableExists === false) {
    await api.db.createTable('claimdrops', ['claimdropId', 'symbol']);
    await api.db.createTable('params');

    const params = {};
    params.creationFee = '1000';
    params.updateFee = '300';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      creationFee,
      updateFee,
    } = payload;

    const params = await api.db.findOne('params', {});

    if (creationFee) {
      if (!api.assert(typeof creationFee === 'string' && !api.BigNumber(creationFee).isNaN() && api.BigNumber(creationFee).gte(0), 'invalid creationFee')) return;
      params.creationFee = creationFee;
    }
    if (updateFee) {
      if (!api.assert(typeof updateFee === 'string' && !api.BigNumber(updateFee).isNaN() && api.BigNumber(updateFee).gte(0), 'invalid updateFee')) return;
      params.updateFee = updateFee;
    }

    await api.db.update('params', params);
  }
};

const hasValidType = (token, type) => {
  if (type === 'transfer') {
    return true;
  }

  // check if staking is enabled
  if (type === 'stake' && api.assert(token.stakingEnabled === true, 'staking not enabled')) {
    return true;
  }

  return false;
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

actions.create = async (payload) => {
  const {
    symbol,
    type,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
      && type && typeof type === 'string', 'invalid params')
    && api.assert(type === 'transfer' || type === 'stake', 'invalid type')) {
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

    // get api.sender's utility and airdrop token balances
    const utilityToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });
    const nativeToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol });

    if (api.assert(token !== null, 'symbol does not exist')
      && hasValidType(token, type)) {

    }
  }
}
