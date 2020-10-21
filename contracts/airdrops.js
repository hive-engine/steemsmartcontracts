/* eslint-disable no-await-in-loop */
/* global actions, api */

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
const CONTRACT_NAME = 'airdrops';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pendingAirdrops');
  if (tableExists === false) {
    await api.db.createTable('pendingAirdrops', ['id', 'symbol']);
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

  // convert csv to an array & then loop through it
  const listArray = list.split(',');
  for (let i = 0; i < listArray.length; i += 1) {
    // get to & quantity from raw value
    const { 0: to, 1: quantity } = listArray[i].split(':');

    if (to && api.isValidAccountName(to)
      && quantity && !api.BigNumber(quantity).isNaN()
      && api.BigNumber(quantity).gt(0) && api.BigNumber(quantity).dp().lte(precision)) {
      airdrop.list.push({
        to,
        quantity,
      });

      // add this quantity to the total quantity of tokens to airdrop
      airdrop.quantity = api.BigNumber(airdrop.quantity).plus(quantity);
    }
  }

  // calculate total fee
  airdrop.fee = api.BigNumber(params.feePerTransaction).times(airdrop.list.length);

  // list validation, check if all values from listArray are valid & pushed into airdrop.list
  if (listArray.length > 0 && listArray.length === airdrop.list.length) {
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

const transferIsSuccesfull = (result, action, from, to, symbol, quantity) => {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens'
    && el.event === action
    && el.data.from === from
    && el.data.to === to
    && el.data.quantity === quantity
    && el.data.symbol === symbol) !== undefined) {
    return true;
  }

  return false;
};

actions.initAirdrop = async (payload) => {
  const {
    symbol,
    type,
    list,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
      && list && typeof list === 'string'
      && type && typeof type === 'string', 'invalid params')
    && api.assert(type === 'transfer' || type === 'stake', 'invalid type')) {
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });

    // get api.sender's utility and airdrop token balances
    const { balance: utilityTokenBalance } = { ...await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL }) };
    const { balance: nativeTokenBalance } = { ...await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol }) };

    if (api.assert(token !== null, 'symbol does not exist')
      && hasValidType(token, type)) {
      const airdrop = await parseAirdrop(list, token.precision);

      if (api.assert(airdrop.list.length > 0 && airdrop.isValid, 'invalid list')
        && api.assert(utilityTokenBalance
          && api.BigNumber(utilityTokenBalance).gte(airdrop.fee), 'you must have enough tokens to cover the airdrop fee')
        && api.assert(nativeTokenBalance
          && api.BigNumber(nativeTokenBalance).gte(airdrop.quantity), 'you must have enough tokens to do the airdrop')) {
        // validations completed
        // lock airdrop tokens by transfering them to contract
        const tokenTransfer = await api.executeSmartContract('tokens', 'transferToContract', {
          to: CONTRACT_NAME, symbol, quantity: airdrop.quantity,
        });

        if (transferIsSuccesfull(tokenTransfer, 'transferToContract', api.sender, 'airdrops', symbol, airdrop.quantity)) {
          // deduct fee from sender's utility token balance
          const feeTransfer = await api.executeSmartContract('tokens', 'transfer', {
            to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: airdrop.fee, isSignedWithActiveKey,
          });

          if (transferIsSuccesfull(feeTransfer, 'transfer', api.sender, 'null', symbol, airdrop.fee)) {
            await api.db.insert('pendingAirdrops', {
              id: api.transactionId,
              symbol,
              type,
              list: airdrop.list,
            });

            api.emit('initAirdrop', { id: api.transactionId });
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
    list,
    symbol,
    type,
  } = airdrop;

  let airdropIsPending = true;
  let count = 0;

  while (airdropIsPending) {
    if (count < maxTransactionsPerBlock) {
      if (list[count] !== undefined) {
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

        // remove this object from airdrop
        airdrop.list.shift();

        count += 1;
      } else {
        // if list[count] is undefined, airdrop is finished
        await api.db.remove('pendingAirdrops', airdrop);
        airdropIsPending = false;
      }
    } else {
      if (airdrop.list.length > 0) {
        // if limit has been reached & transactions are still remaining, update airdrop
        await api.db.update('pendingAirdrops', airdrop);
      } else {
        // if no other transactions are remaining, delete airdrop
        await api.db.remove('pendingAirdrops', airdrop);
      }

      airdropIsPending = false;
    }
  }
};

actions.checkPendingAirdrops = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const params = await api.db.findOne('params', {});
    const pendingAirdrops = await api.db.find('pendingAirdrops',
      {},
      params.maxAirdropsPerBlock,
      0,
      [{ index: 'id', descending: false }]);

    for (let i = 0; i < pendingAirdrops.length; i += 1) {
      const airdrop = pendingAirdrops[i];
      await processAirdrop(airdrop, params.maxTransactionsPerBlock);
    }
  }
};
