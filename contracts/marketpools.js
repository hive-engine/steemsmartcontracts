/* eslint-disable max-len */
/* global actions, api */

const TradeType = ['exactInput', 'exactOutput'];

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pools');
  if (tableExists === false) {
    await api.db.createTable('pools', ['tokenPair']);
    await api.db.createTable('liquidityPositions', ['account', 'tokenPair']);
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

function getAmountIn(amountOut, liquidityIn, liquidityOut) {
  if (!api.assert(api.BigNumber(amountOut).gt(0), 'insufficient output amount')
    || !api.assert(api.BigNumber(liquidityIn).gt(0)
      && api.BigNumber(liquidityOut).gt(0)
      && api.BigNumber(amountOut).lt(liquidityOut), 'insufficient liquidity')) return false;
  const num = api.BigNumber(liquidityIn).times(amountOut);
  const den = api.BigNumber(liquidityOut).minus(amountOut);
  return num.dividedBy(den);
}

function getAmountOut(amountIn, liquidityIn, liquidityOut) {
  if (!api.assert(api.BigNumber(amountIn).gt(0), 'insufficient output amount')
    || !api.assert(api.BigNumber(liquidityIn).gt(0)
      && api.BigNumber(liquidityOut).gt(0), 'insufficient liquidity')) return false;
  const num = api.BigNumber(amountIn).times(liquidityOut);
  const den = api.BigNumber(liquidityIn).plus(amountIn);
  const amountOut = num.dividedBy(den);
  if (!api.assert(api.BigNumber(amountOut).lt(liquidityOut), 'insufficient liquidity')) return false;
  return amountOut;
}

async function validateOracle(pool, newPrice, maxDeviation = 0.01) {
  const [baseSymbol, quoteSymbol] = pool.tokenPair.split(':');
  // eslint-disable-next-line no-template-curly-in-string
  const baseMetrics = baseSymbol !== "'${CONSTANTS.HIVE_PEGGED_SYMBOL}$'"
    ? await api.db.findOneInTable('market', 'metrics', { symbol: baseSymbol })
    : { lastPrice: 1 };
  // eslint-disable-next-line no-template-curly-in-string
  const quoteMetrics = quoteSymbol !== "'${CONSTANTS.HIVE_PEGGED_SYMBOL}$'"
    ? await api.db.findOneInTable('market', 'metrics', { symbol: quoteSymbol })
    : { lastPrice: 1 };
  if (!baseMetrics || !quoteMetrics) return null; // no oracle available
  const oracle = api.BigNumber(quoteMetrics.lastPrice).dividedBy(baseMetrics.lastPrice);
  const dev = api.BigNumber(api.BigNumber(newPrice - oracle).abs()).dividedBy(oracle);
  // api.debug(`${oracle} -> ${dev} / ${maxDeviation}`);
  if (!api.assert(api.BigNumber(dev).lte(maxDeviation), 'exceeded max deviation from order book')) return false;
  return true;
}

function validateLiquiditySwap(pool, baseDelta, quoteDelta) {
  const p = api.BigNumber(pool.quoteQuantity).dividedBy(pool.baseQuantity).toFixed(pool.precision);
  // api.debug(`P - ${p}`);
  if (!api.assert(api.BigNumber(api.BigNumber(quoteDelta).dividedBy(baseDelta).toFixed(pool.precision)).eq(p),
    `constant price ${api.BigNumber(quoteDelta).dividedBy(baseDelta)}, expected ${p}`)) return false;
  return true;
}

function validateSwap(pool, baseDelta, quoteDelta, maxSlippage) {
  const k = api.BigNumber(pool.baseQuantity).times(pool.quoteQuantity).toFixed(pool.precision);
  const baseAdjusted = api.BigNumber(pool.baseQuantity).plus(baseDelta);
  const quoteAdjusted = api.BigNumber(pool.quoteQuantity).plus(quoteDelta);
  const p = api.BigNumber(pool.quoteQuantity).dividedBy(pool.baseQuantity).toFixed(pool.precision);
  const pAdjusted = api.BigNumber(quoteAdjusted).dividedBy(baseAdjusted).toFixed(pool.precision);
  const slippage = api.BigNumber(api.BigNumber(pAdjusted - p).abs()).dividedBy(p);
  if (!api.assert(api.BigNumber(slippage).lte(maxSlippage), 'exceeded max slippage for swap')) return false;
  if (!api.assert(api.BigNumber(api.BigNumber(baseAdjusted).times(quoteAdjusted).toFixed(pool.precision)).eq(k),
    `constant product ${api.BigNumber(baseAdjusted).times(quoteAdjusted)}, expected ${k}`)) return false;
  return true;
}

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

async function validatePool(tokenPair) {
  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const pool = await api.db.findOne('pools', { tokenPair });
  const revPool = await api.db.findOne('pools', { tokenPair: [quoteSymbol, baseSymbol].join(':') });
  if (!api.assert(pool === null && revPool === null, 'a pool already exists for this tokenPair')) return false;
  return true;
}

async function updatePoolStats(pool, baseAdjusted, quoteAdjusted, swap = true) {
  const uPool = pool;
  // precise quantities are needed here for K calculation
  uPool.baseQuantity = api.BigNumber(pool.baseQuantity).plus(baseAdjusted);
  uPool.quoteQuantity = api.BigNumber(pool.quoteQuantity).plus(quoteAdjusted);
  // remainder are statistical and can be rounded (updated for swaps only)
  uPool.basePrice = api.BigNumber(uPool.quoteQuantity).dividedBy(uPool.baseQuantity).toFixed(pool.precision);
  uPool.quotePrice = api.BigNumber(uPool.baseQuantity).dividedBy(uPool.quoteQuantity).toFixed(pool.precision);
  if (swap) {
    uPool.baseVolume = api.BigNumber(uPool.baseVolume).plus(Math.abs(baseAdjusted)).toFixed(pool.precision);
    uPool.quoteVolume = api.BigNumber(uPool.quoteVolume).plus(Math.abs(quoteAdjusted)).toFixed(pool.precision);
  }
  await api.db.update('pools', uPool);
}

actions.createPool = async (payload) => {
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
    && await validateTokenPair(tokenPair)
    && await validatePool(tokenPair)
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
    || !await validateTokenPair(tokenPair)) return;

  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const baseToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: baseSymbol });
  const quoteToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: quoteSymbol });
  if (!api.assert(api.BigNumber(baseQuantity).dp() <= baseToken.precision, 'baseQuantity precision mismatch')
    || !api.assert(api.BigNumber(quoteQuantity).dp() <= quoteToken.precision, 'quoteQuantity precision mismatch')) return;

  const pool = await api.db.findOne('pools', { tokenPair });
  if (api.assert(pool, 'no existing pool for tokenPair')) {
    if (api.BigNumber(pool.baseQuantity).eq(0) && api.BigNumber(pool.quoteQuantity).eq(0)
      && await validateOracle(pool, api.BigNumber(quoteQuantity).dividedBy(baseQuantity)) === false) return;
    if (api.BigNumber(pool.baseQuantity).gt(0) && api.BigNumber(pool.quoteQuantity).gt(0)
      && !validateLiquiditySwap(pool, baseQuantity, quoteQuantity)) return;

    const senderBase = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: baseSymbol });
    const senderQuote = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: quoteSymbol });
    const senderFunded = api.BigNumber(senderBase.balance).gte(baseQuantity) && api.BigNumber(senderQuote.balance).gte(quoteQuantity);
    if (!api.assert(senderFunded, 'insufficient token balance')) return;

    // update liquidity position
    const lp = await api.db.findOne('liquidityPositions', { account: api.sender, tokenPair });
    if (lp) {
      lp.baseQuantity = api.BigNumber(lp.baseQuantity).plus(baseQuantity);
      lp.quoteQuantity = api.BigNumber(lp.quoteQuantity).plus(quoteQuantity);
      await api.db.update('liquidityPositions', lp);
    } else {
      const newlp = {
        account: api.sender,
        tokenPair,
        baseQuantity,
        quoteQuantity,
      };
      await api.db.insert('liquidityPositions', newlp);
    }

    // deposit requested tokens to contract
    const baseRes = await api.executeSmartContract('tokens', 'transferToContract', { symbol: baseSymbol, quantity: baseQuantity, to: 'marketpools' });
    const quoteRes = await api.executeSmartContract('tokens', 'transferToContract', { symbol: quoteSymbol, quantity: quoteQuantity, to: 'marketpools' });
    if (!api.assert(baseRes.errors === undefined && quoteRes.errors === undefined, 'deposit transfer errors')) return;
    updatePoolStats(pool, baseQuantity, quoteQuantity, false);
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
    || !await validateTokenPair(tokenPair)) {
    return;
  }

  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const baseToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: baseSymbol });
  const quoteToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: quoteSymbol });
  if (!api.assert(api.BigNumber(baseQuantity).dp() <= baseToken.precision, 'baseQuantity precision mismatch')
    || !api.assert(api.BigNumber(quoteQuantity).dp() <= quoteToken.precision, 'quoteQuantity precision mismatch')) return;

  const pool = await api.db.findOne('pools', { tokenPair });
  if (api.assert(pool, 'no existing pool for tokenPair')) {
    if (!api.assert(api.BigNumber(pool.baseQuantity).gt(0)
      && api.BigNumber(pool.quoteQuantity).gt(0), 'insufficient liquidity')
      || !validateLiquiditySwap(pool, baseQuantity, quoteQuantity)) return;

    const lp = await api.db.findOne('liquidityPositions', { account: api.sender, tokenPair });
    if (api.assert(lp, 'no existing liquidity position')
      && api.assert(api.BigNumber(lp.baseQuantity).minus(baseQuantity).gte(0)
      && api.BigNumber(lp.quoteQuantity).minus(quoteQuantity).gte(0), 'not enough liquidity in position')) {
      lp.baseQuantity = api.BigNumber(lp.baseQuantity).minus(baseQuantity);
      lp.quoteQuantity = api.BigNumber(lp.quoteQuantity).minus(quoteQuantity);
      if (api.BigNumber(lp.baseQuantity).eq(0) && api.BigNumber(lp.quoteQuantity).eq(0)) {
        await api.db.remove('liquidityPositions', lp);
      } else {
        await api.db.update('liquidityPositions', lp);
      }

      await api.transferTokens(api.sender, baseSymbol, baseQuantity, 'user');
      await api.transferTokens(api.sender, quoteSymbol, quoteQuantity, 'user');
      updatePoolStats(pool, -baseQuantity, -quoteQuantity, false);
      api.emit('removeLiquidity', { memo: `Remove ${baseSymbol} and ${quoteSymbol}` });
    }
  }
};

actions.swapTokens = async (payload) => {
  const {
    tokenPair,
    tokenSymbol,
    tokenAmount,
    tradeType,
    maxSlippage,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    || !api.assert(typeof (tokenSymbol) === 'string', 'invalid token')
    || !api.assert(tokenAmount && api.BigNumber(tokenAmount).gt(0), 'insufficient tokenAmount')
    || !api.assert(maxSlippage && api.BigNumber(maxSlippage).gt(0) && api.BigNumber(maxSlippage).lt(50), 'maxSlippage must be greater than 0 and less than 50')
    || !api.assert(typeof (tradeType) === 'string' && TradeType.indexOf(tradeType) !== -1, 'invalid tradeType')
    || !await validateTokenPair(tokenPair)) {
    return;
  }

  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const pool = await api.db.findOne('pools', { tokenPair });
  if (!api.assert(pool, 'no existing pool for tokenPair')) return;
  let liquidityIn;
  let liquidityOut;
  let symbolIn;
  let symbolOut;
  const tradeDirection = tradeType === 'exactInput' ? tokenSymbol === baseSymbol : tokenSymbol !== baseSymbol;
  if (tradeDirection) {
    liquidityIn = pool.baseQuantity;
    liquidityOut = pool.quoteQuantity;
    symbolIn = baseSymbol;
    symbolOut = quoteSymbol;
  } else {
    liquidityIn = pool.quoteQuantity;
    liquidityOut = pool.baseQuantity;
    symbolIn = quoteSymbol;
    symbolOut = baseSymbol;
  }

  const tokenIn = await api.db.findOneInTable('tokens', 'tokens', { symbol: symbolIn });
  const tokenOut = await api.db.findOneInTable('tokens', 'tokens', { symbol: symbolOut });

  const senderBase = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: symbolIn });
  let senderBaseFunded = false;
  let tokenPairDelta;
  let tokenQuantity;
  if (tradeType === 'exactInput') {
    const tokenAmountAdjusted = api.BigNumber(getAmountOut(tokenAmount, liquidityIn, liquidityOut));
    if (!tokenAmountAdjusted.isFinite()) return;
    senderBaseFunded = senderBase && api.BigNumber(senderBase.balance).gte(tokenAmount);
    tokenPairDelta = tokenSymbol === baseSymbol ? [tokenAmount, api.BigNumber(tokenAmountAdjusted).times(-1)] : [api.BigNumber(tokenAmountAdjusted).times(-1), tokenAmount];
    tokenQuantity = { in: tokenAmount, out: tokenAmountAdjusted };
    if (!api.assert(api.BigNumber(tokenQuantity.in).dp() <= tokenIn.precision, 'symbolIn precision mismatch')) return;
  } else if (tradeType === 'exactOutput') {
    const tokenAmountAdjusted = api.BigNumber(getAmountIn(tokenAmount, liquidityIn, liquidityOut));
    if (!tokenAmountAdjusted.isFinite()) return;
    senderBaseFunded = senderBase && api.BigNumber(senderBase.balance).gte(tokenAmountAdjusted);
    tokenPairDelta = tokenSymbol === baseSymbol ? [api.BigNumber(tokenAmount).times(-1), tokenAmountAdjusted] : [tokenAmountAdjusted, api.BigNumber(tokenAmount).times(-1)];
    tokenQuantity = { in: tokenAmountAdjusted, out: tokenAmount };
    if (!api.assert(api.BigNumber(tokenQuantity.out).dp() <= tokenOut.precision, 'symbolOut precision mismatch')) return;
  }

  if (!api.assert(senderBaseFunded, 'insufficient input balance')
    || !validateSwap(pool, tokenPairDelta[0], tokenPairDelta[1], api.BigNumber(maxSlippage).dividedBy(100))) return;

  const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol: symbolIn, quantity: api.BigNumber(tokenQuantity.in).toFixed(tokenIn.precision), to: 'marketpools' });
  if (res.errors === undefined
    && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'marketpools' && el.data.quantity === api.BigNumber(tokenQuantity.in).toFixed(tokenIn.precision)) !== undefined) {
    await api.transferTokens(api.sender, symbolOut, api.BigNumber(tokenQuantity.out).toFixed(tokenOut.precision), 'user');
    updatePoolStats(pool, tokenPairDelta[0], tokenPairDelta[1]);
    api.emit('swapTokens', { memo: `Swap ${symbolIn} for ${symbolOut}` });
  }
};
