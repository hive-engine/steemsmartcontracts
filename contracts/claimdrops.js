/* eslint-disable no-await-in-loop */
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
    // 90 days (in milliseconds)
    params.maxExpiryTime = 7776000000;
    params.maxExpiresPerBlock = 5;
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      creationFee,
      feePerClaim,
      maxExpiryTime,
      maxExpiresPerBlock,
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
    if (maxExpiryTime) {
      if (!api.assert(Number.isInteger(maxExpiryTime) && maxExpiryTime > 0, 'invalid maxExpiryTime')) return;
      params.maxExpiryTime = maxExpiryTime;
    }
    if (maxExpiresPerBlock) {
      if (!api.assert(Number.isInteger(maxExpiresPerBlock) && maxExpiresPerBlock > 0 && maxExpiresPerBlock <= 1000, 'invalid maxExpiresPerBlock')) return;
      params.maxExpiresPerBlock = maxExpiresPerBlock;
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
  for (let i = 0; i < list.length; i += 1) {
    const { 0: account, 1: limit } = list[i];

    // account & limit validation
    if (api.assert(account, `list[${i}]: account name cannot be undefined`)
      && api.assert(api.isValidAccountName(account), `list[${i}]: invalid account name`)
      && api.assert(limit, `list[${i}]: limit cannot be undefined`)
      && api.assert(!api.BigNumber(limit).isNaN(), `list[${i}]: invalid limit`)
      && api.assert(api.BigNumber(limit).gt(0), `list[${i}]: limit must be positive`)
      && api.assert(hasValidPrecision(limit, precision), `list[${i}]: limit precision mismatch`)) {
      parsedList.push({
        account,
        limit,
      });
    } else break;
  }

  // list validation, check if all values from list are valid & pushed into parsedList
  if (api.assert(list.length > 0, 'list cannot be empty') && parsedList.length === list.length) return parsedList;
  return false;
};

const isValidowner = async (name, type) => {
  if (type === 'user') {
    if (api.isValidAccountName(name)) return true;
  } else if (type === 'contract') {
    const contract = await api.db.findContract(name);
    if (contract) return true;
  }

  return false;
};

actions.create = async (payload) => {
  const {
    symbol,
    price,
    pool,
    maxClaims,
    expiry,
    owner,
    ownerType,
    list,
    limit,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
      && price && typeof price === 'string' && !api.BigNumber(price).isNaN()
      && pool && typeof pool === 'string' && !api.BigNumber(pool).isNaN()
      && maxClaims && Number.isInteger(maxClaims)
      && expiry && typeof expiry === 'string'
      && owner && typeof owner === 'string'
      && ownerType && typeof ownerType === 'string'
      // limit for everyone -OR- list with limit for selected users
      && ((!limit && list && Array.isArray(list))
        || (!list && limit && typeof limit === 'string' && !api.BigNumber(limit).isNaN())), 'invalid params')) {
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
    const params = await api.db.findOne('params', {});

    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();
    const expiryTimestamp = getTimestamp(expiry);
    const maxExpiryTimestamp = api.BigNumber(timestamp)
      .plus(params.maxExpiryTime).toNumber();

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
      && api.assert(expiryTimestamp && expiryTimestamp > timestamp, 'invalid expiry')
      && api.assert(expiryTimestamp <= maxExpiryTimestamp, 'expiry exceeds limit')
      && api.assert(ownerType === 'user' || ownerType === 'contract', 'invalid ownerType')
      && api.assert(await isValidowner(owner, ownerType), 'invalid owner')) {
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
          expiry: expiryTimestamp,
          owner,
          ownerType,
        };

        // add list or limit to final claimdrop object
        if (list) {
          const parsedList = validateList(list, token.precision);
          if (parsedList) {
            claimdrop.list = parsedList;
          } else return;
        } else if (limit) {
          if (api.assert(api.BigNumber(limit).gt(0), 'limit must be positive')
            && api.assert(hasValidPrecision(limit, token.precision), 'limit precision mismatch')) {
            claimdrop.limit = limit;
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

const isActive = (expiry) => {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.00Z`);
  const timestamp = blockDate.getTime();
  if (expiry > timestamp) return true;

  return false;
};

actions.claim = async (payload) => {
  const {
    claimdropId,
    quantity,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(claimdropId && typeof claimdropId === 'string'
      && quantity && typeof quantity === 'string' && !api.BigNumber(quantity).isNaN(), 'invalid params')) {
    const claimdrop = await api.db.findOne('claimdrops', { claimdropId });

    if (api.assert(claimdrop, 'claimdrop does not exist or has been expired')
      && api.assert(isActive(claimdrop.expiry), 'claimdrop has been expired')) {
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: claimdrop.symbol });

      if (api.assert(claimdrop.remainingClaims > 0, 'maximum claims limit has been reached')
        && api.assert(api.BigNumber(quantity).gt(0), 'quantity must be positive')
        && api.assert(hasValidPrecision(quantity, token.precision), 'quantity precision mismatch')
        && api.assert(api.BigNumber(claimdrop.remainingPool).gt(0), 'pool limit has been reached')
        && api.assert(api.BigNumber(claimdrop.remainingPool).minus(quantity).gte(0), 'quantity exceeds pool')) {
        const price = api.BigNumber(claimdrop.price)
          .times(quantity)
          .toFixed(HIVE_PEGGED_SYMBOL_PRECISION);
        if (!api.assert(api.BigNumber(price).gt(0), 'quantity too low')) return;
        const hivePeggedToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: HIVE_PEGGED_SYMBOL });

        const previousClaimIndex = claimdrop.claims.findIndex(el => el.account === api.sender);
        const previousClaim = claimdrop.claims[previousClaimIndex];
        const claim = (previousClaim) ? {
          account: previousClaim.account,
          quantity: api.BigNumber(previousClaim.quantity).plus(quantity),
        } : {
          account: api.sender,
          quantity,
        };

        // get limit for api.sender from list or global limit
        let limit;
        if (claimdrop.list) {
          const accountInList = claimdrop.list.find(el => el.account === claim.account);
          // assert if list exist but account is not in it
          if (!api.assert(accountInList, 'you are not eligible')) return;
          ({ limit } = accountInList);
        } else ({ limit } = claimdrop);

        if (previousClaim && !api.assert(!api.BigNumber(previousClaim.quantity).eq(limit), 'you have reached your limit')) return;
        if (api.assert(hivePeggedToken && hivePeggedToken.balance
          && api.BigNumber(hivePeggedToken.balance).gte(price), 'you must have enough tokens to cover the price')
          && api.assert(api.BigNumber(claim.quantity).lte(limit), 'quantity exceeds your limit')) {
          // deduct price
          const transferType = (claimdrop.ownerType === 'user') ? 'transfer' : 'transferToContract';
          const transfer = await api.executeSmartContract('tokens', transferType, {
            to: claimdrop.owner, symbol: HIVE_PEGGED_SYMBOL, quantity: price,
          });

          if (transferIsSuccessful(transfer,
            transferType, api.sender, claimdrop.owner, HIVE_PEGGED_SYMBOL, price)) {
            // transfer tokens to claimant
            await api.transferTokens(api.sender, claimdrop.symbol, quantity, 'user');

            if (previousClaim) claimdrop.claims[previousClaimIndex] = claim;
            else claimdrop.claims.push(claim);

            claimdrop.remainingPool = api.BigNumber(claimdrop.remainingPool)
              .minus(quantity);
            claimdrop.remainingClaims -= 1;

            await api.db.update('claimdrops', claimdrop);
            api.emit('claim', {
              claimdropId: claimdrop.claimdropId,
              quantity,
            });
          }
        }
      }
    }
  }
};

actions.checkExpiredClaimdrops = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const params = await api.db.findOne('params', {});
    const blockDate = new Date(`${api.hiveBlockTimestamp}.00Z`);
    const timestamp = blockDate.getTime();
    const expiredClaimdrops = await api.db.find('claimdrops',
      {
        expiry: { $lte: timestamp },
      },
      params.maxExpiresPerBlock,
      0,
      [{ index: '_id', descending: false }]);

    for (let i = 0; i < expiredClaimdrops.length; i += 1) {
      const claimdrop = expiredClaimdrops[i];
      const {
        remainingPool, symbol, owner, ownerType,
      } = claimdrop;
      if (api.BigNumber(remainingPool).gt(0)) {
        await api.transferTokens(owner, symbol, remainingPool, ownerType);
      }
      // delete claimdrop
      await api.db.remove('claimdrops', claimdrop);

      api.emit('expire', {
        claimdropId: claimdrop.claimdropId,
      });
    }
  }
};
