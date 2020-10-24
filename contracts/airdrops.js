/* eslint-disable no-await-in-loop */
/* global actions, api */

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_PRECISION = '${CONSTANTS.UTILITY_TOKEN_PRECISION}$';
const CONTRACT_NAME = 'airdrops';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pendingAirdrops');
  if (tableExists === false) {
    await api.db.createTable('pendingAirdrops', ['airdropId', 'symbol']);
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

const parseAirdrop = async (list, precision) => {
  const params = await api.db.findOne('params', {});
  const airdrop = {};
  airdrop.list = [];
  airdrop.fee = '0';
  airdrop.quantity = '0';
  airdrop.isValid = false;

  // loop through list and validate
  for (let i = 0; i < list.length; i += 1) {
    const { 0: to, 1: quantity } = list[i];

    if (api.assert(to, `list[${i}]: account name cannot be undefined`)
      && api.assert(api.isValidAccountName(to), `list[${i}]: invalid account name`)
      && api.assert(quantity, `list[${i}]: quantity cannot be undefined`)
      && api.assert(!api.BigNumber(quantity).isNaN(), `list[${i}]: invalid quantity`)
      && api.assert(api.BigNumber(quantity).gt(0), `list[${i}]: quantity must be positive`)
      && api.assert(api.BigNumber(quantity).dp() <= precision, `list[${i}]: quantity precision mismatch`)) {
      airdrop.list.push({
        to,
        quantity,
      });

      // add this quantity to the total quantity of tokens to airdrop
      airdrop.quantity = api.BigNumber(airdrop.quantity).plus(quantity);
    } else break;
  }

  // calculate total fee
  airdrop.fee = api.BigNumber(params.feePerTransaction).times(airdrop.list.length)
    .toFixed(UTILITY_TOKEN_PRECISION);

  // list validation, check if all values from list are valid & pushed into airdrop.list
  if (api.assert(list.length > 0, 'list cannot be empty') && list.length === airdrop.list.length) {
    airdrop.isValid = true;
  }

  return airdrop;
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

actions.newAirdrop = async (payload) => {
  const {
    symbol,
    type,
    list,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
      && type && typeof type === 'string'
      && list && Array.isArray(list), 'invalid params')
    && api.assert(type === 'transfer' || type === 'stake', 'invalid type')) {
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

    // get api.sender's utility and airdrop token balances
    const utilityToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });
    const nativeToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol });

    if (api.assert(token !== null, 'symbol does not exist')
      && hasValidType(token, type)) {
      const airdrop = await parseAirdrop(list, token.precision);

      if (airdrop.isValid
        && api.assert(utilityToken && utilityToken.balance
          && api.BigNumber(utilityToken.balance).gte(airdrop.fee), 'you must have enough tokens to cover the airdrop fee')
        && api.assert(nativeToken && nativeToken.balance
          && api.BigNumber(nativeToken.balance).gte(airdrop.quantity), 'you must have enough tokens to do the airdrop')) {
        // validations completed
        // lock airdrop tokens by transfering them to contract
        const tokenTransfer = await api.executeSmartContract('tokens', 'transferToContract', {
          to: CONTRACT_NAME, symbol, quantity: airdrop.quantity,
        });

        if (transferIsSuccessful(tokenTransfer, 'transferToContract', api.sender, CONTRACT_NAME, symbol, airdrop.quantity)) {
          // deduct fee from sender's utility token balance
          const feeTransfer = await api.executeSmartContract('tokens', 'transfer', {
            to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: airdrop.fee, isSignedWithActiveKey,
          });

          if (transferIsSuccessful(feeTransfer, 'transfer', api.sender, 'null', UTILITY_TOKEN_SYMBOL, airdrop.fee)) {
            const res = await api.db.insert('pendingAirdrops', {
              airdropId: api.transactionId,
              symbol,
              type,
              list: airdrop.list,
              blockNumber: api.blockNumber,
            });

            api.emit('newAirdrop', { airdropId: res.airdropId });
          } else {
            // if fee transfer was failed, return native balance to api.sender
            await api.transferTokens(api.sender, symbol, airdrop.quantity, 'user');
          }
        }
      }
    }
  }
};

const processAirdrop = async (airdrop, maxTransactionsPerBlock) => {
  const {
    airdropId,
    list,
    symbol,
    type,
  } = airdrop;

  let count = 0;

  while (count < maxTransactionsPerBlock && list[count] !== undefined) {
    const { to, quantity } = list[count];

    if (type === 'transfer') {
      // transfer tokens
      await api.transferTokens(to, symbol, quantity, 'user');
    } else if (type === 'stake') {
      // stake tokens
      await api.executeSmartContract('tokens', 'stakeFromContract', {
        to, symbol, quantity,
      });
    }

    count += 1;
  }

  api.BigNumber(count).plus(1);
  airdrop.list.splice(0, count);

  if (airdrop.list.length > 0) {
    // if limit has been reached & transactions are still remaining, update airdrop
    await api.db.update('pendingAirdrops', airdrop);
  } else {
    // if no other transactions are remaining, delete airdrop
    await api.db.remove('pendingAirdrops', airdrop);
  }

  api.emit('airdropDistribution', {
    airdropId,
    transactions: count,
  });
};

actions.checkPendingAirdrops = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const params = await api.db.findOne('params', {});
    const pendingAirdrops = await api.db.find('pendingAirdrops',
      {
        blockNumber: { $lt: api.blockNumber },
      },
      params.maxAirdropsPerBlock,
      0,
      [{ index: '_id', descending: false }]);

    for (let i = 0; i < pendingAirdrops.length; i += 1) {
      const airdrop = pendingAirdrops[i];
      await processAirdrop(airdrop, params.maxTransactionsPerBlock);
    }
  }
};
