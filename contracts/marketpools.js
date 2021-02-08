/* eslint-disable max-len */
/* global actions, api */

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pools');
  if (tableExists === false) {
    await api.db.createTable('pools', ['tokenPair']);
    await api.db.createTable('liquidityPosition', ['account', 'tokenPair']);
    await api.db.createTable('params');

    const params = {};
    params.poolCreationFee = '1000';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  const { poolCreationFee } = payload;
  if (api.sender !== api.owner) return;
  const params = await api.db.findOne('params', {});
  if (poolCreationFee) {
    if (!api.assert(typeof poolCreationFee === 'string' && !api.BigNumber(poolCreationFee).isNaN() && api.BigNumber(poolCreationFee).gte(0), 'invalid poolCreationFee')) return;
    params.poolCreationFee = poolCreationFee;
  }
  await api.db.update('params', params);
};

async function validateTokenPair(tokenPair) {
  if (!api.assert(typeof (tokenPair) === 'string' && tokenPair.indexOf(':') !== -1, 'invalid tokenPair format')) return false;
  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  if (!api.assert(baseSymbol !== quoteSymbol, 'tokenPair cannot be the same token')
    || !api.assert(await api.db.findOneInTable('tokens', 'tokens', { symbol: baseSymbol }), 'baseSymbol does not exist')
    || !api.assert(await api.db.findOneInTable('tokens', 'tokens', { symbol: quoteSymbol }), 'quoteSymbol does not exist')) {
    return false;
  }
  return true;
}

function getAmountOut(amountIn, liquidityIn, liquidityOut) {
  if (!api.assert(api.BigNumber(amountIn).gt(0), 'insufficient input amount')
    || !api.assert(api.BigNumber(liquidityIn).gt(0) && api.BigNumber(liquidityOut).gt(0), 'insufficient liquidity')) return false;
  return api.BigNumber(amountIn).times(liquidityOut).dividedBy(api.BigNumber(liquidityIn).add(amountIn));
}

function getAmountIn(amountOut, liquidityIn, liquidityOut) {
  if (!api.assert(api.BigNumber(amountOut).gt(0), 'insufficient output amount')
    || !api.assert(api.BigNumber(liquidityIn).gt(0) && api.BigNumber(liquidityOut).gt(0), 'insufficient liquidity')) return false;
  return api.BigNumber(liquidityIn).times(amountOut).dividedBy(api.BigNumber(liquidityOut).minus(amountOut));
}

function validateNewLiquidity(pool, baseIn, quoteIn) {
  const k = api.BigNumber(pool.baseQuantity).times(pool.quoteQuantity);
  const baseAdjusted = api.BigNumber(pool.baseQuantity).plus(baseIn);
  const quoteAdjusted = api.BigNumber(pool.quoteQuantity).plus(quoteIn);
  if (!api.assert(api.BigNumber(baseAdjusted).times(quoteAdjusted).eq(k), 'liquidity can only be added to maintain current price')) return false;
  return true;
}

async function validateSwap(pool, baseOut, quoteOut) {
  if (!api.assert(api.BigNumber(baseOut).lt(pool.baseQuantity) || api.BigNumber(quoteOut).lt(pool.quoteQuantity), 'insufficient liquidity')) return false;
  const [baseSymbol, quoteSymbol] = pool.tokenPair.split(':');
  const k = api.BigNumber(pool.baseQuantity).times(pool.quoteQuantity);
  let baseBalance = await api.db.findOneInTable('tokens', 'contractsBalances', { account: 'marketpools', symbol: baseSymbol });
  let quoteBalance = await api.db.findOneInTable('tokens', 'contractsBalances', { account: 'marketpools', symbol: quoteSymbol });
  baseBalance = baseBalance.balance;
  quoteBalance = quoteBalance.balance;
  const baseIn = api.BigNumber(baseBalance).gt(api.BigNumber(pool.baseQuantity).minus(baseOut)) ? api.BigNumber(baseBalance).minus(api.BigNumber(pool.baseQuantity).minus(baseOut)) : 0;
  const quoteIn = api.BigNumber(quoteBalance).gt(api.BigNumber(pool.quoteQuantity).minus(quoteOut)) ? api.BigNumber(quoteBalance).minus(api.BigNumber(pool.quoteQuantity).minus(quoteOut)) : 0;
  if (api.assert(api.BigNumber(baseIn).gt(0) || api.BigNumber(quoteIn).gt(0), 'insufficient input amount')) return false;
  const baseAdjusted = api.BigNumber(baseBalance).minus(baseIn);
  const quoteAdjusted = api.BigNumber(quoteBalance).minus(quoteIn);
  if (!api.assert(api.BigNumber(baseAdjusted).times(quoteAdjusted).eq(k), 'constant product validation K')) return false;
  return true;
}

async function updatePoolStats(pool, baseAdjusted, quoteAdjusted) {
  const uPool = pool;
  uPool.baseQuantity = api.BigNumber(pool.baseQuantity).plus(baseAdjusted).toFixed(pool.precision);
  uPool.quoteQuantity = api.BigNumber(pool.quoteQuantity).plus(quoteAdjusted).toFixed(pool.precision);
  uPool.basePrice = api.BigNumber(uPool.quoteQuantity).dividedBy(uPool.baseQuantity).toFixed(pool.precision);
  uPool.quotePrice = api.BigNumber(uPool.baseQuantity).dividedBy(uPool.quoteQuantity).toFixed(pool.precision);
  uPool.baseVolume = api.BigNumber(uPool.baseVolume).plus(Math.abs(baseAdjusted)).toFixed(pool.precision);
  uPool.quoteVolume = api.BigNumber(uPool.quoteVolume).plus(Math.abs(quoteAdjusted)).toFixed(pool.precision);
  await api.db.update('pools', uPool);
}

actions.create = async (payload) => {
  const {
    tokenPair, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { poolCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(poolCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(poolCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && validateTokenPair(tokenPair)
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    const [baseSymbol, quoteSymbol] = tokenPair.split(':');
    const baseToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: baseSymbol });
    const quoteToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: quoteSymbol });
    const newPool = {
      tokenPair,
      baseQuantity: 0,
      baseVolume: 0,
      basePrice: 0, // Base per Quote (usual way of reading a pair)
      quoteQuantity: 0,
      quoteVolume: 0,
      quotePrice: 0, // Quote per Base (reverse price)
      precision: Math.min(baseToken.precision, quoteToken.precision),
      active: true,
      creator: api.sender,
    };
    await api.db.insert('pools', newPool);

    // burn the token creation fees
    if (api.sender !== api.owner && api.BigNumber(poolCreationFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: poolCreationFee, isSignedWithActiveKey,
      });
    }
    api.emit('createPool', { tokenPair });
  }
};

actions.addLiquidity = async (payload) => {
  const {
    tokenPair,
    baseQuantity,
    quoteQuantity,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    || !api.assert(baseQuantity && api.BigNumber(baseQuantity).gt(0), 'invalid baseQuantity')
    || !api.assert(quoteQuantity && api.BigNumber(quoteQuantity).gt(0), 'invalid quoteQuantity')
    || !validateTokenPair(tokenPair)) {
    return;
  }

  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const pool = await api.db.findOne('pools', { tokenPair });
  if (api.assert(pool, 'no existing pool for tokenPair')) {
    // existing pools must add liquidity according to current price/product
    if (api.BigNumber(pool.baseQuantity).gt(0) && api.BigNumber(pool.quoteQuantity).gt(0)
      && !validateNewLiquidity(pool, baseQuantity, quoteQuantity)) return;

    // update liquidity position
    const lp = await api.db.findOne('liquidityPosition', { account: api.sender, tokenPair });
    if (lp) {
      lp.baseQuantity = api.BigNumber(lp.baseQuantity).plus(baseQuantity);
      lp.quoteQuantity = api.BigNumber(lp.quoteQuantity).plus(quoteQuantity);
      await api.db.update('liquidityPosition', lp);
    } else {
      const newlp = {
        account: api.sender,
        tokenPair,
        baseQuantity,
        quoteQuantity,
      };
      await api.db.insert('liquidityPosition', newlp);
    }

    // deposit requested tokens to contract
    let res = await api.executeSmartContract('tokens', 'transferToContract', { symbol: baseSymbol, quantity: baseQuantity, to: 'marketpools' });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'marketpools' && el.data.quantity === baseQuantity) !== undefined) {
      pool.baseQuantity = api.BigNumber(pool.baseQuantity).plus(baseQuantity);
    }
    res = await api.executeSmartContract('tokens', 'transferToContract', { symbol: quoteSymbol, quantity: quoteQuantity, to: 'marketpools' });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'marketpools' && el.data.quantity === quoteQuantity) !== undefined) {
      pool.quoteQuantity = api.BigNumber(pool.quoteQuantity).plus(quoteQuantity);
    }
    if (api.assert(api.BigNumber(pool.baseQuantity).gt(0) && api.BigNumber(pool.quoteQuantity).gt(0), 'tokens transferToContract was not successful')) {
      pool.basePrice = api.BigNumber(pool.quoteQuantity).dividedBy(pool.baseQuantity);
      pool.quotePrice = api.BigNumber(pool.baseQuantity).dividedBy(pool.quoteQuantity);
    }
    await api.db.update('pools', pool);

    api.emit('addLiquidity', { memo: `Add ${baseSymbol} and ${quoteSymbol}` });
  }
};

actions.removeLiquidity = async (payload) => {
  const {
    tokenPair,
    baseQuantity,
    quoteQuantity,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    || !api.assert(baseQuantity && api.BigNumber(baseQuantity).gt(0), 'invalid baseQuantity')
    || !api.assert(quoteQuantity && api.BigNumber(quoteQuantity).gt(0), 'invalid quoteQuantity')
    || !validateTokenPair(tokenPair)) {
    return;
  }

  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const lp = await api.db.findOne('liquidityPosition', { account: api.sender, tokenPair });
  if (api.assert(lp, 'no existing liquidity position for this account/tokenPair')
    && api.assert(api.BigNumber(lp.baseQuantity).minus(baseQuantity).gte(0), 'not enough baseSymbol to remove')
    && api.assert(api.BigNumber(lp.quoteQuantity).minus(quoteQuantity).gte(0), 'not enough quoteSymbol to remove')) {
    lp.baseQuantity = api.BigNumber(lp.baseQuantity).minus(baseQuantity);
    lp.quoteQuantity = api.BigNumber(lp.quoteQuantity).minus(quoteQuantity);
    if (lp.baseQuantity === 0 && lp.quoteQuantity === 0) {
      await api.db.delete('liquidityPosition', lp);
    } else {
      await api.db.update('liquidityPosition', lp);
    }

    await api.transferTokens(api.sender, baseSymbol, baseQuantity, 'user');
    await api.transferTokens(api.sender, quoteSymbol, quoteQuantity, 'user');
    api.emit('removeLiquidity', { memo: `Remove ${baseSymbol} and ${quoteSymbol}` });
  }
};

actions.swapForQuote = async (payload) => {
  const {
    tokenPair,
    quoteOut,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    || !api.assert(quoteOut && api.BigNumber(quoteOut).gt(0), 'invalid quoteQuantity')
    || !validateTokenPair(tokenPair)) {
    return;
  }

  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const pool = await api.db.findOne('pools', { tokenPair });
  if (api.assert(pool, 'no existing pool for tokenPair')) {
    const baseIn = api.BigNumber(getAmountIn(quoteOut, pool.baseQuantity, pool.quoteQuantity)).toFixed(pool.precision);
    const senderBase = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: baseSymbol });
    const senderBaseFunded = api.BigNumber(senderBase.balance).gte(baseIn);
    if (senderBaseFunded && validateSwap(pool, baseIn, quoteOut)) {
      await api.executeSmartContract('tokens', 'transferToContract', { symbol: baseSymbol, quantity: baseIn, to: 'marketpools' });
      await api.transferTokens(api.sender, quoteSymbol, quoteOut, 'user');
      updatePoolStats(pool, baseIn, api.BigNumber(quoteOut).times(-1));
      api.emit('swapForQuote', { memo: `Swap ${baseSymbol} for ${quoteSymbol}` });
    }
  }
};
