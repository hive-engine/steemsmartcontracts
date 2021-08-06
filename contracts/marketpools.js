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
  } else {
    const params = await api.db.findOne('params', {});
    if (!params.updateIndex) {
      const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
      let lpUpdate = await api.db.find('liquidityPositions', {
        timeFactor: {
          $exists: false,
        },
      });
      while (lpUpdate.length > 0) {
        for (let i = 0; i < lpUpdate.length; i += 1) {
          const lp = lpUpdate[i];
          lp.timeFactor = blockDate.getTime();
          // eslint-disable-next-line no-await-in-loop
          await api.db.update('liquidityPositions', lp);
        }
        // eslint-disable-next-line no-await-in-loop
        lpUpdate = await api.db.find('liquidityPositions', {
          timeFactor: {
            $exists: false,
          },
        });
      }
      params.updateIndex = 1;
      await api.db.update('params', params);
    }
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

function getQuote(amount, liquidityIn, liquidityOut) {
  if (!api.assert(api.BigNumber(amount).gt(0), 'insufficient amount')
    || !api.assert(api.BigNumber(liquidityIn).gt(0)
      && api.BigNumber(liquidityOut).gt(0), 'insufficient liquidity')) return false;
  return api.BigNumber(amount).times(liquidityOut).dividedBy(liquidityIn);
}

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

async function validateOracle(pool, newPrice, maxDeviation = api.BigNumber('0.01')) {
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
  const oracle = api.BigNumber(baseMetrics.lastPrice).dividedBy(quoteMetrics.lastPrice);
  const dev = api.BigNumber(newPrice).minus(oracle).abs().dividedBy(oracle);
  // api.debug(`${oracle} -> ${dev} / ${maxDeviation}`);
  if (!api.assert(api.BigNumber(dev).lte(maxDeviation), 'exceeded max deviation from order book')) return false;
  return true;
}

function validateSwap(pool, baseDelta, quoteDelta, maxSlippage) {
  const k = api.BigNumber(pool.baseQuantity).times(pool.quoteQuantity).toFixed(pool.precision, api.BigNumber.ROUND_HALF_UP);
  const baseAdjusted = api.BigNumber(pool.baseQuantity).plus(baseDelta);
  const quoteAdjusted = api.BigNumber(pool.quoteQuantity).plus(quoteDelta);
  const kAdjusted = api.BigNumber(baseAdjusted).times(quoteAdjusted).toFixed(pool.precision, api.BigNumber.ROUND_HALF_UP);
  const p = api.BigNumber(pool.quoteQuantity).dividedBy(pool.baseQuantity).toFixed(pool.precision, api.BigNumber.ROUND_HALF_UP);
  const pAdjusted = api.BigNumber(quoteAdjusted).dividedBy(baseAdjusted).toFixed(pool.precision, api.BigNumber.ROUND_HALF_UP);
  const slippage = api.BigNumber(pAdjusted).minus(p).abs().dividedBy(p);
  if (!api.assert(api.BigNumber(slippage).lte(maxSlippage), 'exceeded max slippage for swap')) return false;
  if (!api.assert(api.BigNumber(kAdjusted).eq(k), `constant product ${kAdjusted}, expected ${k}`)) return false;
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

async function updatePoolStats(pool, baseAdjusted, quoteAdjusted, sharesAdjusted, swap) {
  const uPool = pool;
  // precise quantities are needed here for K calculation
  // remainder are statistical and can be rounded (updated for swaps only)
  uPool.baseQuantity = api.BigNumber(pool.baseQuantity).plus(baseAdjusted).toFixed(pool.precision, api.BigNumber.ROUND_HALF_UP);
  uPool.quoteQuantity = api.BigNumber(pool.quoteQuantity).plus(quoteAdjusted).toFixed(pool.precision, api.BigNumber.ROUND_HALF_UP);

  // if all LP is removed, don't update the last price
  if (api.BigNumber(uPool.baseQuantity).gt(0) && api.BigNumber(uPool.quoteQuantity).gt(0)) {
    uPool.basePrice = api.BigNumber(uPool.quoteQuantity).dividedBy(uPool.baseQuantity).toFixed(pool.precision, api.BigNumber.ROUND_DOWN);
    uPool.quotePrice = api.BigNumber(uPool.baseQuantity).dividedBy(uPool.quoteQuantity).toFixed(pool.precision, api.BigNumber.ROUND_DOWN);
  }
  if (sharesAdjusted) {
    uPool.totalShares = api.BigNumber(pool.totalShares).plus(sharesAdjusted);
  }
  if (swap) {
    uPool.baseVolume = api.BigNumber(uPool.baseVolume).plus(Math.abs(baseAdjusted)).toFixed(pool.precision, api.BigNumber.ROUND_DOWN);
    uPool.quoteVolume = api.BigNumber(uPool.quoteVolume).plus(Math.abs(quoteAdjusted)).toFixed(pool.precision, api.BigNumber.ROUND_DOWN);
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
      totalShares: 0,
      precision: Math.max(baseToken.precision, quoteToken.precision),
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

actions.createRewardPool = async (payload) => {
  const {
    tokenPair, lotteryWinners, lotteryIntervalHours, lotteryAmount, minedToken,
    isSignedWithActiveKey,
  } = payload;

  // get mining contract params
  const params = await api.db.findOneInTable('mining', 'params', {});
  const { poolCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(poolCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(poolCreationFee);

  const poolPositions = await api.db.find('liquidityPositions', { tokenPair });

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
  && await validateTokenPair(tokenPair)
  && api.assert(poolPositions && poolPositions.length > 0, 'pool must have liquidity positions')
  && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    const rewardPoolId = `${minedToken}:EXT-${tokenPair.replace(':', '')}`;
    const res = await api.executeSmartContract('mining', 'createPool', {
      lotteryWinners,
      lotteryIntervalHours,
      lotteryAmount,
      minedToken,
      externalMiners: tokenPair,
    });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'mining' && el.event === 'createPool') !== undefined) {
      await api.executeSmartContract('mining', 'setActive', { id: rewardPoolId, active: true });
      api.emit('createRewardPool', { tokenPair, rewardPoolId });
    }
  }
};

actions.updateRewardPool = async (payload) => {
  const {
    tokenPair, lotteryWinners, lotteryIntervalHours, lotteryAmount, minedToken,
    isSignedWithActiveKey,
  } = payload;

  // get mining contract params
  const params = await api.db.findOneInTable('mining', 'params', {});
  const { poolUpdateFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedUpdate = api.BigNumber(poolUpdateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(poolUpdateFee);

  const poolPositions = await api.db.find('liquidityPositions', { tokenPair });

  if (api.assert(authorizedUpdate, 'you must have enough tokens to cover the update fee')
  && await validateTokenPair(tokenPair)
  && api.assert(poolPositions && poolPositions.length > 0, 'pool must have liquidity positions')
  && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    const rewardPoolId = `${minedToken}:EXT-${tokenPair.replace(':', '')}`;
    const res = await api.executeSmartContract('mining', 'updatePool', {
      id: rewardPoolId,
      lotteryWinners,
      lotteryIntervalHours,
      lotteryAmount,
    });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'mining' && el.event === 'updatePool') !== undefined) {
      api.emit('updateRewardPool', { tokenPair, rewardPoolId });
    }
  }
};

actions.setRewardPoolActive = async (payload) => {
  const {
    tokenPair,
    minedToken,
    active,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    || !await validateTokenPair(tokenPair)) return;

  const rewardPoolId = `${minedToken}:EXT-${tokenPair.replace(':', '')}`;
  const result = await api.executeSmartContract('mining', 'setActive', { id: rewardPoolId, active });
  if (result.errors === undefined) api.emit('setRewardPoolActive', { rewardPoolId, active });
};

actions.addLiquidity = async (payload) => {
  const {
    tokenPair,
    baseQuantity,
    quoteQuantity,
    maxSlippage,
    maxDeviation,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    || !api.assert(typeof baseQuantity === 'string' && api.BigNumber(baseQuantity).gt(0), 'invalid baseQuantity')
    || !api.assert(typeof quoteQuantity === 'string' && api.BigNumber(quoteQuantity).gt(0), 'invalid quoteQuantity')
    || !await validateTokenPair(tokenPair)) return;

  let addSlippage = api.BigNumber('0.01');
  if (maxSlippage) {
    if (!api.assert(typeof maxSlippage === 'string' && api.BigNumber(maxSlippage).gt(0) && api.BigNumber(maxSlippage).lt(50)
      && api.BigNumber(maxSlippage).dp() <= 3, 'maxSlippage must be greater than 0 and less than 50')) return;
    addSlippage = api.BigNumber(maxSlippage).dividedBy(100);
  }

  let addDeviation = api.BigNumber('0.01');
  if (maxDeviation) {
    if (!api.assert(typeof maxDeviation === 'string'
      && api.BigNumber(maxDeviation).isInteger()
      && api.BigNumber(maxDeviation).gte(0), 'maxDeviation must be an integer greater than or equal to 0')) return;
    addDeviation = api.BigNumber(maxDeviation).dividedBy(100);
  }

  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const baseToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: baseSymbol });
  const quoteToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: quoteSymbol });
  if (!api.assert(api.BigNumber(baseQuantity).dp() <= baseToken.precision, 'baseQuantity precision mismatch')
    || !api.assert(api.BigNumber(quoteQuantity).dp() <= quoteToken.precision, 'quoteQuantity precision mismatch')) return;

  const pool = await api.db.findOne('pools', { tokenPair });
  if (api.assert(pool, 'no existing pool for tokenPair')) {
    if (api.BigNumber(pool.baseQuantity).eq(0) && api.BigNumber(pool.quoteQuantity).eq(0)
      && addDeviation.gt(0)
      && await validateOracle(pool, api.BigNumber(quoteQuantity).dividedBy(baseQuantity), addDeviation) === false) return;

    let amountAdjusted;
    const baseMin = api.BigNumber(baseQuantity).times(api.BigNumber('1').minus(addSlippage));
    const quoteMin = api.BigNumber(quoteQuantity).times(api.BigNumber('1').minus(addSlippage));
    if (api.BigNumber(pool.baseQuantity).gt(0) && api.BigNumber(pool.quoteQuantity).gt(0)) {
      const quoteOptimal = getQuote(baseQuantity, pool.baseQuantity, pool.quoteQuantity).toFixed(quoteToken.precision, api.BigNumber.ROUND_HALF_UP);
      if (api.BigNumber(quoteOptimal).lte(quoteQuantity)) {
        if (!api.assert(api.BigNumber(quoteOptimal).gte(quoteMin), 'exceeded max slippage for adding liquidity')) return;
        amountAdjusted = [baseQuantity, quoteOptimal];
      } else {
        const baseOptimal = getQuote(quoteQuantity, pool.quoteQuantity, pool.baseQuantity).toFixed(baseToken.precision, api.BigNumber.ROUND_HALF_UP);
        if (api.BigNumber(baseOptimal).lte(baseQuantity)) {
          if (!api.assert(api.BigNumber(baseOptimal).gte(baseMin), 'exceeded max slippage for adding liquidity')) return;
          amountAdjusted = [baseOptimal, quoteQuantity];
        }
      }
    } else {
      amountAdjusted = [baseQuantity, quoteQuantity];
    }

    const senderBase = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: baseSymbol });
    const senderQuote = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: quoteSymbol });
    const senderFunded = senderBase && senderQuote && api.BigNumber(senderBase.balance).gte(amountAdjusted[0]) && api.BigNumber(senderQuote.balance).gte(amountAdjusted[1]);
    if (!api.assert(senderFunded, 'insufficient token balance')) return;

    let newShares;
    if (api.BigNumber(pool.totalShares).eq(0)) {
      newShares = api.BigNumber(amountAdjusted[0]).times(amountAdjusted[1]).sqrt();
    } else {
      newShares = api.BigNumber.min(
        api.BigNumber(amountAdjusted[0]).times(pool.totalShares).dividedBy(pool.baseQuantity),
        api.BigNumber(amountAdjusted[1]).times(pool.totalShares).dividedBy(pool.quoteQuantity),
      );
    }
    if (!api.assert(api.BigNumber(newShares).gt(0), 'insufficient liquidity created')) return;

    // update liquidity position
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const lp = await api.db.findOne('liquidityPositions', { account: api.sender, tokenPair });
    if (lp) {
      const existingShares = lp.shares;
      const finalShares = api.BigNumber(lp.shares).plus(newShares);
      const timeOffset = api.BigNumber(finalShares).minus(existingShares).abs().dividedBy(existingShares);
      lp.shares = finalShares;
      lp.timeFactor = api.BigNumber.min(
        api.BigNumber(lp.timeFactor)
          .times(api.BigNumber('1').plus(timeOffset))
          .dp(0, api.BigNumber.ROUND_HALF_UP),
        blockDate.getTime(),
      ).toNumber();
      await api.db.update('liquidityPositions', lp);
    } else {
      const newlp = {
        account: api.sender,
        tokenPair,
        shares: newShares,
        timeFactor: blockDate.getTime(),
      };
      await api.db.insert('liquidityPositions', newlp);
    }

    // deposit requested tokens to contract
    const baseRes = await api.executeSmartContract('tokens', 'transferToContract', { symbol: baseSymbol, quantity: amountAdjusted[0], to: 'marketpools' });
    const quoteRes = await api.executeSmartContract('tokens', 'transferToContract', { symbol: quoteSymbol, quantity: amountAdjusted[1], to: 'marketpools' });
    if (!api.assert(baseRes.errors === undefined && quoteRes.errors === undefined, 'deposit transfer errors')) return;
    await updatePoolStats(pool, amountAdjusted[0], amountAdjusted[1], newShares, false);
    api.emit('addLiquidity', { baseSymbol, quoteSymbol });
  }
};

actions.removeLiquidity = async (payload) => {
  const {
    tokenPair,
    sharesOut,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    || !api.assert(typeof sharesOut === 'string' && api.BigNumber(sharesOut).gt(0) && api.BigNumber(sharesOut).lte(100)
      && api.BigNumber(sharesOut).dp() <= 3, 'invalid sharesOut, must be > 0 <= 100')
    || !await validateTokenPair(tokenPair)) {
    return;
  }

  const [baseSymbol, quoteSymbol] = tokenPair.split(':');
  const baseToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: baseSymbol });
  const quoteToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: quoteSymbol });

  const pool = await api.db.findOne('pools', { tokenPair });
  if (api.assert(pool, 'no existing pool for tokenPair')) {
    const lp = await api.db.findOne('liquidityPositions', { account: api.sender, tokenPair });
    if (api.assert(lp, 'no existing liquidity position')) {
      const sharesDelta = api.BigNumber(lp.shares).times(sharesOut).dividedBy(100);
      const baseOut = api.BigNumber(sharesDelta).times(pool.baseQuantity).dividedBy(pool.totalShares).toFixed(baseToken.precision, api.BigNumber.ROUND_DOWN);
      const quoteOut = api.BigNumber(sharesDelta).times(pool.quoteQuantity).dividedBy(pool.totalShares).toFixed(quoteToken.precision, api.BigNumber.ROUND_DOWN);

      if (!api.assert(api.BigNumber(baseOut).gt(0) && api.BigNumber(quoteOut).gt(0)
        && api.BigNumber(pool.baseQuantity).gte(baseOut) && api.BigNumber(pool.quoteQuantity).gte(quoteOut), 'insufficient liquidity')) return;

      lp.shares = api.BigNumber(lp.shares).minus(sharesDelta);

      if (api.BigNumber(lp.shares).eq(0)) {
        await api.db.remove('liquidityPositions', lp);
      } else {
        await api.db.update('liquidityPositions', lp);
      }

      const baseRes = await api.transferTokens(api.sender, baseSymbol, baseOut, 'user');
      const quoteRes = await api.transferTokens(api.sender, quoteSymbol, quoteOut, 'user');
      if (!api.assert(baseRes.errors === undefined && quoteRes.errors === undefined, 'withdrawal transfer errors')) return;
      await updatePoolStats(pool, api.BigNumber(baseOut).negated(), api.BigNumber(quoteOut).negated(), api.BigNumber(sharesDelta).negated(), false);
      api.emit('removeLiquidity', { baseSymbol, quoteSymbol });
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
    || !api.assert(typeof tokenSymbol === 'string', 'invalid token')
    || !api.assert(typeof tokenAmount === 'string' && api.BigNumber(tokenAmount).gt(0), 'insufficient tokenAmount')
    || !api.assert(typeof maxSlippage === 'string' && api.BigNumber(maxSlippage).gt(0) && api.BigNumber(maxSlippage).lt(50)
      && api.BigNumber(maxSlippage).dp() <= 3, 'maxSlippage must be greater than 0 and less than 50')
    || !api.assert(typeof tradeType === 'string' && TradeType.indexOf(tradeType) !== -1, 'invalid tradeType')
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
    tokenPairDelta = tokenSymbol === baseSymbol ? [tokenAmount, api.BigNumber(tokenAmountAdjusted).negated()] : [api.BigNumber(tokenAmountAdjusted).negated(), tokenAmount];
    tokenQuantity = { in: tokenAmount, out: tokenAmountAdjusted };
    if (!api.assert(api.BigNumber(tokenQuantity.in).dp() <= tokenIn.precision, 'symbolIn precision mismatch')) return;
  } else if (tradeType === 'exactOutput') {
    const tokenAmountAdjusted = api.BigNumber(getAmountIn(tokenAmount, liquidityIn, liquidityOut));
    if (!tokenAmountAdjusted.isFinite()) return;
    senderBaseFunded = senderBase && api.BigNumber(senderBase.balance).gte(tokenAmountAdjusted.toFixed(tokenIn.precision, api.BigNumber.ROUND_HALF_UP));
    tokenPairDelta = tokenSymbol === baseSymbol ? [api.BigNumber(tokenAmount).negated(), tokenAmountAdjusted] : [tokenAmountAdjusted, api.BigNumber(tokenAmount).negated()];
    tokenQuantity = { in: tokenAmountAdjusted, out: tokenAmount };
    if (!api.assert(api.BigNumber(tokenQuantity.out).dp() <= tokenOut.precision, 'symbolOut precision mismatch')) return;
  }

  tokenQuantity.in = api.BigNumber(tokenQuantity.in).dp(tokenIn.precision, api.BigNumber.ROUND_CEIL);
  tokenQuantity.out = api.BigNumber(tokenQuantity.out).dp(tokenOut.precision, api.BigNumber.ROUND_DOWN);
  if (!api.assert(tokenQuantity.in.gt(0), 'symbolIn precision mismatch')
    || !api.assert(tokenQuantity.out.gt(0), 'symbolOut precision mismatch')) return;

  if (!api.assert(senderBaseFunded, 'insufficient input balance')
    || !validateSwap(pool, tokenPairDelta[0], tokenPairDelta[1], api.BigNumber(maxSlippage).dividedBy(100))) return;

  const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol: symbolIn, quantity: tokenQuantity.in.toFixed(), to: 'marketpools' });
  if (res.errors === undefined
    && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'marketpools' && el.data.quantity === tokenQuantity.in.toFixed()) !== undefined) {
    await api.transferTokens(api.sender, symbolOut, tokenQuantity.out.toFixed(), 'user');
    await updatePoolStats(pool, tokenPairDelta[0], tokenPairDelta[1], false, true);
    api.emit('swapTokens', { symbolIn, symbolOut });
  }
};
