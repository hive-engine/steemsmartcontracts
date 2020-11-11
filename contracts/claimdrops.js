/* global actions, api */

const UTILITY_TOKEN_SYMBOL = 'BEE';
const UTILITY_TOKEN_PRECISION = 8;
const HIVE_PEGGED_SYMBOL = 'SWAP.HIVE';
const HIVE_PEGGED_SYMBOL_PRECISION = 8;
const CONTRACT_NAME = 'claimdrops';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('claimdrops');
  if (tableExists === false) {
    await api.db.createTable('claimdrops', ['claimdropId', 'symbol']);
    await api.db.createTable('params');

    const params = {};
    params.creationFee = '50';
    params.feePerClaim = '0.1';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      creationFee,
      feePerClaim,
    } = payload;

    const params = await api.db.findOne('params', {});

    if (creationFee) {
      if (!api.assert(typeof creationFee === 'string' && !api.BigNumber(creationFee).isNaN() && api.BigNumber(creationFee).gte(0), 'invalid creationFee')) return;
      params.creationFee = creationFee;
    }
    if (feePerClaim) {
      if (!api.assert(typeof feePerClaim === 'string' && !api.BigNumber(feePerClaim).isNaN() && api.BigNumber(feePerClaim).gte(0), 'invalid feePerClaim')) return;
      params.feePerClaim = feePerClaim;
    }

    await api.db.update('params', params);
  }
};

const hasValidPrecision = (value, precision) => (api.BigNumber(value).dp() <= precision);

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

const getTimestamp = (value) => {
  try {
    const date = new Date(`${value}.00Z`);
    return date.getTime();
  } catch (e) {
    return false;
  }
};

const validateList = (list, precision) => {
  const parsedList = [];
  if (list.length > 0) {
    for (let i = 0; i < list.length; i += 1) {
      const { 0: account, 1: limit } = list[i];

      // account & limit validation
      if (api.assert(account, `list[${i}]: account name cannot be undefined`)
        && api.assert(api.isValidAccountName(account), `list[${i}]: invalid account name`)
        && api.assert(limit, `list[${i}]: limit cannot be undefined`)
        && api.assert(!api.BigNumber(limit).isNaN(), `list[${i}]: invalid limit`)
        && api.assert(api.BigNumber(limit).gt(0), `list[${i}]: limit must be positive`)
        && api.assert(api.BigNumber(limit).dp() <= precision, `list[${i}]: limit precision mismatch`)) {
        parsedList.push({
          account,
          limit,
        });
      } else break;
    }
  } else return false;

  // list validation, check if all values from list are valid & pushed into parsedList
  if (parsedList.length === list.length) return parsedList;
  return false;
};

actions.create = async (payload) => {
  const {
    symbol,
    price,
    pool,
    maxClaims,
    expiry,
    list,
    maxClaimEach,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
      && price && typeof price === 'string' && !api.BigNumber(price).isNaN()
      && pool && typeof pool === 'string' && !api.BigNumber(pool).isNaN()
      && maxClaims && Number.isInteger(maxClaims)
      && expiry && typeof expiry === 'string'
      // max claim for everyone -OR- list with max claim for selected users
      && ((!maxClaimEach && list && Array.isArray(list))
        || (!list && maxClaimEach && typeof maxClaimEach === 'string' && !api.BigNumber(maxClaimEach).isNaN())), 'invalid params')) {
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
    const params = await api.db.findOne('params', {});
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();
    const expiryTimestamp = getTimestamp(expiry);

    // get api.sender's utility and airdrop token balances
    const utilityToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });
    const nativeToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol });

    if (api.assert(token !== null, 'symbol does not exist')
      // price checks
      && api.assert(api.BigNumber(price).gt(0), 'price must be positive')
      && api.assert(hasValidPrecision(price, HIVE_PEGGED_SYMBOL_PRECISION), 'price precision mismatch')
      // pool checks
      && api.assert(api.BigNumber(pool).gt(0), 'pool must be positive')
      && api.assert(hasValidPrecision(pool, token.precision), 'pool precision mismatch')
      // maxClaims check
      && api.assert(api.BigNumber(maxClaims).gt(0), 'maxClaims must be positive number')
      // expiry check
      && api.assert(expiryTimestamp && expiryTimestamp > timestamp, 'invalid expiry')) {
      const fee = api.BigNumber(params.feePerClaim).times(maxClaims)
        .plus(params.creationFee)
        .toFixed(UTILITY_TOKEN_PRECISION);

      // balance checks
      if (api.assert(utilityToken && utilityToken.balance
        && api.BigNumber(utilityToken.balance).gte(fee), 'you must have enough tokens to cover the creation fee')
        && api.assert(nativeToken && nativeToken.balance
          && api.BigNumber(nativeToken.balance).gte(pool), 'you must have enough tokens to cover the claimdrop pool')) {
        const claimdrop = {
          claimdropId: api.transactionId,
          symbol,
          price,
          remainingPool: pool,
          remainingClaims: maxClaims,
          claims: [],
          expiry,
        };

        // add list or maxClaimEach to final claimdrop object
        if (list) {
          const parsedList = validateList(list, token.precision);
          if (parsedList) {
            claimdrop.list = parsedList;
          } else return;
        } else if (maxClaimEach) {
          if (api.assert(api.BigNumber(maxClaimEach).gt(0), 'maxClaimEach must be positive')
            && api.assert(hasValidPrecision(maxClaimEach, token.precision), 'maxClaimEach precision mismatch')) {
            claimdrop.maxClaimEach = maxClaimEach;
          } else return;
        }

        // lock tokens by transfering them to contract
        const tokenTransfer = await api.executeSmartContract('tokens', 'transferToContract', {
          to: CONTRACT_NAME, symbol, quantity: pool,
        });

        if (transferIsSuccessful(tokenTransfer, 'transferToContract', api.sender, CONTRACT_NAME, symbol, pool)) {
          // deduct fee from sender's utility token balance
          const feeTransfer = await api.executeSmartContract('tokens', 'transfer', {
            to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: fee, isSignedWithActiveKey,
          });

          if (transferIsSuccessful(feeTransfer, 'transfer', api.sender, 'null', UTILITY_TOKEN_SYMBOL, fee)) {
            const res = await api.db.insert('claimdrops', claimdrop);

            api.emit('create', { claimdropId: res.claimdropId });
          } else {
            // if fee transfer was failed, return native balance to api.sender
            await api.transferTokens(api.sender, symbol, pool, 'user');
          }
        }
      }
    }
  }
};
