/* eslint-disable no-await-in-loop */
/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
/* global actions, api */

const SMT_PRECISION = 10;
const MAX_VOTING_POWER = 10000;
const MAX_WEIGHT = 10000;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('rewardPools');
  if (tableExists === false) {
    await api.db.createTable('params');
    await api.db.createTable('rewardPools');
    await api.db.createTable('posts', [
      'authorperm',
      { name: 'byCashoutTime', index: { rewardPoolId: 1, cashoutTime: 1 } },
      { name: 'byScoreTrend', index: { rewardPoolId: 1, scoreTrend: 1 } },
    ], { primaryKey: ['authorperm', 'rewardPoolId'] });
    await api.db.createTable('votes', [{ name: 'byTimestamp', index: { rewardPoolId: 1, authorperm: 1, timestamp: 1 } }], { primaryKey: ['rewardPoolId', 'authorperm', 'voter'] });
    await api.db.createTable('votingPower', [], { primaryKey: ['rewardPoolId', 'account'] });

    const params = {
      setupFee: '1000',
      updateFee: '100',
      maintenanceTokensPerAction: 5,
      maintenanceTokenOffset: 0,
      maxPostsProcessedPerRound: 1000,
    };
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    setupFee,
    updateFee,
    maintenanceTokensPerAction,
    maxPostsProcessedPerRound,
  } = payload;

  const params = await api.db.findOne('params', {});

  if (setupFee) {
    if (!api.assert(typeof setupFee === 'string' && !api.BigNumber(setupFee).isNaN() && api.BigNumber(setupFee).gte(0), 'invalid setupFee')) return;
    params.setupFee = setupFee;
  }
  if (updateFee) {
    if (!api.assert(typeof updateFee === 'string' && !api.BigNumber(updateFee).isNaN() && api.BigNumber(updateFee).gte(0), 'invalid updateFee')) return;
    params.updateFee = updateFee;
  }
  if (maintenanceTokensPerAction) {
    if (!api.assert(Number.isInteger(maintenanceTokensPerAction) && maintenanceTokensPerAction >= 1, 'invalid maintenanceTokensPerAction')) return;
    params.maintenanceTokensPerAction = maintenanceTokensPerAction;
  }
  if (maxPostsProcessedPerRound) {
    if (!api.assert(Number.isInteger(maxPostsProcessedPerRound) && maxPostsProcessedPerRound >= 1, 'invalid maxPostsProcessedPerRound')) return;
    params.maxPostsProcessedPerRound = maxPostsProcessedPerRound;
  }

  await api.db.update('params', params);
};

function calculateWeightRshares(rewardPool, voteRshareSum) {
  if (api.BigNumber(voteRshareSum).lte(0)) return api.BigNumber(0);
  if (rewardPool.config.postRewardCurve === 'power') {
    const postRewardExponent = api.BigNumber(rewardPool.config.postRewardCurveParameter);
    if (postRewardExponent.eq('1') || postRewardExponent.eq('2')) {
      return api.BigNumber(voteRshareSum).pow(rewardPool.config.postRewardCurveParameter)
        .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    }
    return api.BigNumber(parseFloat(voteRshareSum)
        ** parseFloat(rewardPool.config.postRewardCurveParameter))
      .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
  }
  return api.BigNumber(voteRshareSum);
}

function calculateCurationWeightRshares(rewardPool, voteRshareSum) {
  if (api.BigNumber(voteRshareSum).lte(0)) return api.BigNumber(0);
  if (rewardPool.config.curationRewardCurve === 'power') {
    const curationRewardExponent = api.BigNumber(rewardPool.config.curationRewardCurveParameter);
    if (curationRewardExponent.eq('0.5')) {
      return api.BigNumber(voteRshareSum).sqrt()
        .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    } if (curationRewardExponent.eq('1')) {
      return api.BigNumber(voteRshareSum).toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    }
    return api.BigNumber(parseFloat(voteRshareSum)
        ** parseFloat(rewardPool.config.curationRewardCurveParameter))
      .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
  }
  return api.BigNumber(voteRshareSum);
}

async function payUser(symbol, quantity, user, stakedRewardPercentage) {
  const quantityBignum = api.BigNumber(quantity);
  const stakedQuantity = quantityBignum.multipliedBy(stakedRewardPercentage).dividedBy(100)
    .toFixed(quantityBignum.dp(), api.BigNumber.ROUND_DOWN);
  const liquidQuantity = quantityBignum.minus(stakedQuantity)
    .toFixed(quantityBignum.dp(), api.BigNumber.ROUND_DOWN);
  let res;
  if (api.BigNumber(liquidQuantity).gt(0)) {
    res = await api.transferTokens(user, symbol, liquidQuantity, 'user');
    if (res.errors) {
      api.debug(`Error paying out liquid ${liquidQuantity} ${symbol} to ${user} (TXID ${api.transactionId}): \n${res.errors}`);
    }
  }
  if (api.BigNumber(stakedQuantity).gt(0)) {
    res = await api.executeSmartContract('tokens', 'stakeFromContract', { to: user, symbol, quantity: stakedQuantity });
    if (res.errors) {
      api.debug(`Error paying out staked ${stakedQuantity} ${symbol} to ${user} (TXID ${api.transactionId}): \n${res.errors}`);
    }
  }
}

async function payOutCurators(rewardPool, token, post, curatorPortion) {
  const {
    authorperm,
    symbol,
    rewardPoolId,
  } = post;
  let offset = 0;
  let votesToPayout = await api.db.find('votes', { authorperm, symbol, rewardPoolId }, 1000, offset, [{ index: 'byTimestamp', descending: false }, { index: '_id', descending: false }]);
  while (votesToPayout.length > 0) {
    for (let i = 0; i < votesToPayout.length; i += 1) {
      const vote = votesToPayout[i];
      if (api.BigNumber(vote.weight) > 0) {
        const totalCurationWeight = calculateCurationWeightRshares(
          rewardPool, post.votePositiveRshareSum,
        );
        const votePay = api.BigNumber(curatorPortion).multipliedBy(vote.curationWeight)
          .dividedBy(totalCurationWeight)
          .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
        api.emit('curationReward', {
          rewardPoolId, authorperm, symbol, account: vote.voter, quantity: votePay,
        });
        await payUser(symbol, votePay, vote.voter, rewardPool.config.stakedRewardPercentage);
      }
    }
    if (votesToPayout.length < 1000) {
      break;
    }
    offset += 1000;
    votesToPayout = await api.db.find('votes', { authorperm, symbol }, 1000, offset, [{ index: 'byTimestamp', descending: false }, { index: '_id', descending: false }]);
  }
}

async function payOutPost(rewardPool, token, post, timestamp) {
  const postClaims = calculateWeightRshares(rewardPool, post.voteRshareSum);
  const postPendingToken = api.BigNumber(rewardPool.pendingClaims).gt(0)
    ? api.BigNumber(rewardPool.rewardPool).multipliedBy(postClaims)
      .dividedBy(rewardPool.pendingClaims).toFixed(token.precision, api.BigNumber.ROUND_DOWN)
    : '0';
  api.debug(rewardPool);
  api.debug(post);

  const curatorPortion = api.BigNumber(postPendingToken)
    .multipliedBy(rewardPool.config.curationRewardPercentage)
    .dividedBy(100)
    .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
  const authorPortion = api.BigNumber(postPendingToken).minus(curatorPortion)
    .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
  // eslint-disable-next-line no-param-reassign
  post.lastPayout = timestamp;
  // eslint-disable-next-line no-param-reassign
  post.totalPayoutValue = postPendingToken;
  // eslint-disable-next-line no-param-reassign
  post.curatorPayoutValue = curatorPortion;
  // eslint-disable-next-line no-param-reassign
  post.scoreTrend = '0';

  await payOutCurators(rewardPool, token, post, curatorPortion);
  api.emit('authorReward', {
    rewardPoolId: post.rewardPoolId,
    authorperm: post.authorperm,
    symbol: post.symbol,
    account: post.author,
    quantity: authorPortion,
  });
  await payUser(post.symbol, authorPortion, post.author, rewardPool.config.stakedRewardPercentage);
  await api.db.update('posts', post);
}

async function computePostRewards(params, rewardPool, token) {
  const {
    lastRewardTimestamp,
    config,
    pendingClaims,
  } = rewardPool;
  const {
    cashoutWindowDays,
  } = config;
  const {
    maxPostsProcessedPerRound,
  } = params;
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();
  const claimsDecayPeriodDays = cashoutWindowDays * 2 + 1;
  const adjustNumer = timestamp - lastRewardTimestamp;
  const adjustDenom = claimsDecayPeriodDays * 24 * 3600 * 1000;

  let newPendingClaims = api.BigNumber(pendingClaims)
    .minus(api.BigNumber(pendingClaims)
      .multipliedBy(adjustNumer)
      .dividedBy(adjustDenom))
    .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);

  // Add posts claims, compute subsequent rewards based on inclusion into claims to
  // ensure it cannot take more of the current pool
  const postsToPayout = await api.db.find('posts',
    {
      rewardPoolId: rewardPool._id,
      lastPayout: { $exists: false },
      cashoutTime: { $lte: timestamp },
    },
    maxPostsProcessedPerRound,
    0,
    [{ index: 'byCashoutTime', descending: false }, { index: '_id', descending: false }]);
  if (postsToPayout) {
    newPendingClaims = api.BigNumber(newPendingClaims).plus(
      postsToPayout.reduce((x, y) => x.plus(calculateWeightRshares(rewardPool, y.voteRshareSum)),
        api.BigNumber(0)),
    )
      .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);

    // eslint-disable-next-line no-param-reassign
    rewardPool.pendingClaims = newPendingClaims;

    let deductFromRewardPool = api.BigNumber(0);
    for (let i = 0; i < postsToPayout.length; i += 1) {
      const post = postsToPayout[i];
      await payOutPost(rewardPool, token, post, timestamp);
      deductFromRewardPool = deductFromRewardPool.plus(post.totalPayoutValue);
    }
    // eslint-disable-next-line no-param-reassign
    rewardPool.rewardPool = api.BigNumber(rewardPool.rewardPool)
      .minus(deductFromRewardPool)
      .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
  }
}

async function tokenMaintenance() {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();
  const params = await api.db.findOne('params', {});
  const { maintenanceTokensPerAction, maintenanceTokenOffset } = params;
  const rewardPools = await api.db.find('rewardPools', { active: true, lastRewardTimestamp: { $lte: timestamp - 3000 } }, maintenanceTokensPerAction, maintenanceTokenOffset);
  if (rewardPools) {
    for (let i = 0; i < rewardPools.length; i += 1) {
      const rewardPool = rewardPools[i];
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: rewardPool.symbol });
      const rewardToAdd = api.BigNumber(rewardPool.config.rewardPerBlock)
        .multipliedBy(timestamp - rewardPool.lastRewardTimestamp)
        .dividedBy(3000)
        .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
      if (api.BigNumber(rewardToAdd).gt(0)) {
        await api.executeSmartContractAsOwner('tokens', 'issueToContract',
          {
            symbol: rewardPool.symbol, quantity: rewardToAdd, to: 'comments', isSignedWithActiveKey: true,
          });
        rewardPool.rewardPool = api.BigNumber(rewardPool.rewardPool).plus(rewardToAdd)
          .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
      }
      // Compute post rewards
      await computePostRewards(params, rewardPool, token);
      rewardPool.lastRewardTimestamp = timestamp;
      await api.db.update('rewardPools', rewardPool);
    }
    if (rewardPools.length < maintenanceTokensPerAction) {
      params.maintenanceTokenOffset = 0;
    } else {
      params.maintenanceTokenOffset += maintenanceTokensPerAction;
    }
  }
}

actions.createRewardPool = async (payload) => {
  const {
    symbol,
    config,
    isSignedWithActiveKey,
  } = payload;
  await tokenMaintenance();
  if (!api.assert(isSignedWithActiveKey === true, 'operation must be signed with your active key')) {
    return;
  }

  const params = await api.db.findOne('params', {});
  const { setupFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(setupFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(setupFee);

  if (!api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')) return;


  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
  if (!api.assert(token, 'token not found')) return;
  if (!api.assert(config && typeof config === 'object', 'config invalid')) return;

  const {
    postRewardCurve,
    postRewardCurveParameter,
    curationRewardCurve,
    curationRewardCurveParameter,
    curationRewardPercentage,
    cashoutWindowDays,
    rewardPerBlock,
    voteRegenerationDays,
    downvoteRegenerationDays,
    stakedRewardPercentage,
    votePowerConsumption,
    downvotePowerConsumption,
  } = config;

  if (!api.assert(postRewardCurve && postRewardCurve === 'power', 'postRewardCurve should be one of: [power]')) return;
  const postExponent = api.BigNumber(postRewardCurveParameter);
  if (!api.assert(typeof postRewardCurveParameter === 'string' && postExponent.isFinite() && postExponent.gte('1') && postExponent.lte('2') && postExponent.dp() <= 2, 'postRewardCurveParameter should be between "1" and "2" with precision at most 2')) return;

  if (!api.assert(curationRewardCurve && curationRewardCurve === 'power', 'curationRewardCurve should be one of: [power]')) return;
  const curationExponent = api.BigNumber(curationRewardCurveParameter);
  if (!api.assert(typeof curationRewardCurveParameter === 'string' && curationExponent.isFinite() && curationExponent.gte('0.5') && curationExponent.lte('1') && curationExponent.dp() <= 2, 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2')) return;

  if (!api.assert(curationRewardPercentage && Number.isInteger(curationRewardPercentage) && curationRewardPercentage >= 0 && curationRewardPercentage <= 100, 'curationRewardPercentage should be an integer between 0 and 100')) return;

  if (!api.assert(cashoutWindowDays && Number.isInteger(cashoutWindowDays) && cashoutWindowDays >= 1 && cashoutWindowDays <= 30, 'cashoutWindowDays should be an integer between 1 and 30')) return;

  const parsedRewardPerBlock = api.BigNumber(rewardPerBlock);
  if (!api.assert(typeof rewardPerBlock === 'string' && parsedRewardPerBlock.isFinite() && parsedRewardPerBlock.gt(0), 'rewardPerBlock invalid')
        || !api.assert(parsedRewardPerBlock.dp() <= token.precision, 'token precision mismatch for rewardPerBlock')) return;

  if (!api.assert(voteRegenerationDays && Number.isInteger(voteRegenerationDays) && voteRegenerationDays >= 1 && voteRegenerationDays <= 30, 'voteRegenerationDays should be an integer between 1 and 30')) return;
  if (!api.assert(downvoteRegenerationDays && Number.isInteger(downvoteRegenerationDays) && downvoteRegenerationDays >= 1 && downvoteRegenerationDays <= 30, 'downvoteRegenerationDays should be an integer between 1 and 30')) return;
  if (!api.assert(stakedRewardPercentage && Number.isInteger(stakedRewardPercentage) && stakedRewardPercentage >= 0 && stakedRewardPercentage <= 100, 'stakedRewardPercentage should be an integer between 0 and 100')) return;
  if (!api.assert(votePowerConsumption && Number.isInteger(votePowerConsumption) && votePowerConsumption >= 1 && votePowerConsumption <= 10000, 'votePowerConsumption should be an integer between 1 and 10000')) return;
  if (!api.assert(downvotePowerConsumption && Number.isInteger(downvotePowerConsumption) && downvotePowerConsumption >= 1 && downvotePowerConsumption <= 10000, 'downvotePowerConsumption should be an integer between 1 and 10000')) return;

  // for now, restrict to 1 pool per symbol, and creator must be issuer.
  if (!api.assert(api.sender === token.issuer, 'must be issuer of token')) return;
  if (!api.assert(token.stakingEnabled, 'token must have staking enabled')) return;

  const existingRewardPool = await api.db.findOne('rewardPools', { symbol });
  if (!api.assert(!existingRewardPool, 'cannot create multiple reward pools per token')) return;

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();

  const rewardPool = {
    symbol,
    rewardPool: '0',
    lastRewardTimestamp: timestamp,
    createdTimestamp: timestamp,
    config,
    pendingClaims: '0',
    active: true,
  };
  const insertedRewardPool = await api.db.insert('rewardPools', rewardPool);
  // burn the token creation fees
  if (api.sender !== api.owner && api.BigNumber(setupFee).gt(0)) {
    await api.executeSmartContract('tokens', 'transfer', {
      // eslint-disable-next-line no-template-curly-in-string
      to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: setupFee, isSignedWithActiveKey,
    });
  }
  api.emit('createRewardPool', { _id: insertedRewardPool._id });
};

actions.updateRewardPool = async (payload) => {
  const {
    rewardPoolId,
    config,
    isSignedWithActiveKey,
  } = payload;
  await tokenMaintenance();
  if (!api.assert(isSignedWithActiveKey === true, 'operation must be signed with your active key')) {
    return;
  }
  // get contract params
  const params = await api.db.findOne('params', {});
  const { updateFee } = params;
  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorized = api.BigNumber(updateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(updateFee);

  if (!api.assert(authorized, 'you must have enough tokens to cover the update fee')) return;

  if (!api.assert(config && typeof config === 'object', 'config invalid')) return;

  const {
    postRewardCurve,
    postRewardCurveParameter,
    curationRewardCurve,
    curationRewardCurveParameter,
    curationRewardPercentage,
    cashoutWindowDays,
    rewardPerBlock,
    voteRegenerationDays,
    downvoteRegenerationDays,
    stakedRewardPercentage,
    votePowerConsumption,
    downvotePowerConsumption,
  } = config;

  const existingRewardPool = await api.db.findOne('rewardPools', { _id: rewardPoolId });
  if (!api.assert(existingRewardPool, 'reward pool not found')) return;

  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: existingRewardPool.symbol });

  if (!api.assert(postRewardCurve && postRewardCurve === 'power', 'postRewardCurve should be one of: [power]')) return;
  existingRewardPool.config.postRewardCurve = postRewardCurve;

  const postExponent = api.BigNumber(postRewardCurveParameter);
  if (!api.assert(typeof postRewardCurveParameter === 'string' && postExponent.isFinite() && postExponent.gte('1') && postExponent.lte('2') && postExponent.dp() <= 2, 'postRewardCurveParameter should be between "1" and "2" with precision at most 2')) return;
  existingRewardPool.config.postRewardCurveParameter = postRewardCurveParameter;

  if (!api.assert(curationRewardCurve && curationRewardCurve === 'power', 'curationRewardCurve should be one of: [power]')) return;
  const curationExponent = api.BigNumber(curationRewardCurveParameter);
  if (!api.assert(typeof curationRewardCurveParameter === 'string' && curationExponent.isFinite() && curationExponent.gte('0.5') && curationExponent.lte('1') && curationExponent.dp() <= 2, 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2')) return;
  existingRewardPool.config.curationRewardCurveParameter = curationRewardCurveParameter;

  if (!api.assert(curationRewardPercentage && Number.isInteger(curationRewardPercentage) && curationRewardPercentage >= 0 && curationRewardPercentage <= 100, 'curationRewardPercentage should be an integer between 0 and 100')) return;
  existingRewardPool.config.curationRewardPercentage = curationRewardPercentage;

  if (!api.assert(cashoutWindowDays && Number.isInteger(cashoutWindowDays) && cashoutWindowDays >= 1 && cashoutWindowDays <= 30, 'cashoutWindowDays should be an integer between 1 and 30')) return;
  existingRewardPool.config.cashoutWindowDays = cashoutWindowDays;

  const parsedRewardPerBlock = api.BigNumber(rewardPerBlock);
  if (!api.assert(typeof rewardPerBlock === 'string' && parsedRewardPerBlock.isFinite() && parsedRewardPerBlock.gt(0), 'rewardPerBlock invalid')
        || !api.assert(parsedRewardPerBlock.dp() <= token.precision, 'token precision mismatch for rewardPerBlock')) return;
  existingRewardPool.config.rewardPerBlock = rewardPerBlock;

  if (!api.assert(voteRegenerationDays && Number.isInteger(voteRegenerationDays) && voteRegenerationDays >= 1 && voteRegenerationDays <= 30, 'voteRegenerationDays should be an integer between 1 and 30')) return;
  existingRewardPool.config.voteRegenerationDays = voteRegenerationDays;

  if (!api.assert(downvoteRegenerationDays && Number.isInteger(downvoteRegenerationDays) && downvoteRegenerationDays >= 1 && downvoteRegenerationDays <= 30, 'downvoteRegenerationDays should be an integer between 1 and 30')) return;
  existingRewardPool.config.downvoteRegenerationDays = downvoteRegenerationDays;

  if (!api.assert(stakedRewardPercentage && Number.isInteger(stakedRewardPercentage) && stakedRewardPercentage >= 0 && stakedRewardPercentage <= 100, 'stakedRewardPercentage should be an integer between 0 and 100')) return;
  existingRewardPool.config.stakedRewardPercentage = stakedRewardPercentage;

  if (!api.assert(votePowerConsumption && Number.isInteger(votePowerConsumption) && votePowerConsumption >= 1 && votePowerConsumption <= 10000, 'votePowerConsumption should be an integer between 1 and 10000')) return;
  existingRewardPool.config.votePowerConsumption = votePowerConsumption;

  if (!api.assert(downvotePowerConsumption && Number.isInteger(downvotePowerConsumption) && downvotePowerConsumption >= 1 && downvotePowerConsumption <= 10000, 'downvotePowerConsumption should be an integer between 1 and 10000')) return;
  existingRewardPool.config.downvotePowerConsumption = downvotePowerConsumption;

  if (!api.assert(api.sender === token.issuer, 'must be issuer of token')) return;

  // burn the fees
  if (api.sender !== api.owner && api.BigNumber(updateFee).gt(0)) {
    await api.executeSmartContract('tokens', 'transfer', {
      // eslint-disable-next-line no-template-curly-in-string
      to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: updateFee, isSignedWithActiveKey,
    });
  }

  await api.db.update('rewardPools', existingRewardPool);
};

actions.setActive = async (payload) => {
  const {
    rewardPoolId,
    active,
    isSignedWithActiveKey,
  } = payload;
  await tokenMaintenance();
  if (!api.assert(isSignedWithActiveKey === true, 'operation must be signed with your active key')) {
    return;
  }

  const existingRewardPool = await api.db.findOne('rewardPools', { _id: rewardPoolId });
  if (!api.assert(existingRewardPool, 'reward pool not found')) return;
  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: existingRewardPool.symbol });
  if (!api.assert(api.sender === token.issuer, 'must be issuer of token')) return;

  existingRewardPool.active = active;
  await api.db.update('rewardPools', existingRewardPool);
};

actions.comment = async (payload) => {
  const {
    author,
    permlink,
    rewardPools,
  } = payload;

  await tokenMaintenance();
  // Node enforces author / permlinks from Hive. Check that sender is null.
  if (!api.assert(api.sender === 'null', 'action must use comment operation')) return;

  if (!api.assert(rewardPools && Array.isArray(rewardPools) && rewardPools.length > 0 && rewardPools.length <= 5, 'rewardPools must have length between 1 and 5')) return;

  const authorperm = `@${author}/${permlink}`;
  // Validate that comment is not an edit (cannot add multiple pools)
  const existingPost = await api.db.findOne('posts', { authorperm });
  if (!api.assert(!existingPost, 'cannot change reward configuration')) return;

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();
  for (let i = 0; i < rewardPools.length; i += 1) {
    const rewardPoolId = rewardPools[i];
    const rewardPool = await api.db.findOne('rewardPools', { _id: rewardPoolId });
    if (rewardPool && rewardPool.active) {
      const cashoutTime = timestamp + rewardPool.config.cashoutWindowDays * 24 * 3600 * 1000;

      const post = {
        rewardPoolId,
        symbol: rewardPool.symbol,
        authorperm,
        author,
        created: timestamp,
        cashoutTime,
        votePositiveRshareSum: '0',
        voteRshareSum: '0',
        scoreTrend: '0',
      };
      await api.db.insert('posts', post);
      api.emit('newComment', { rewardPoolId, symbol: rewardPool.symbol });
    }
  }
};

function computeTrendScore(post) {
  const modScore = parseFloat(post.voteRshareSum);
  const order = Math.log10(Math.max(Math.abs(modScore), 1));
  const sign = modScore > 0 ? 1 : -1;
  return api.BigNumber(sign * order + post.created / 480000000)
    .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
}

async function processVote(post, voter, weight, timestamp) {
  const {
    rewardPoolId,
    symbol,
    authorperm,
    cashoutTime,
  } = post;

  if (cashoutTime < timestamp) {
    return;
  }

  // check voting power, stake, and current vote rshares.
  const rewardPool = await api.db.findOne('rewardPools', { _id: rewardPoolId });
  if (!rewardPool || !rewardPool.active) {
    return;
  }

  let votingPower = await api.db.findOne('votingPower', { rewardPoolId, account: voter });
  if (!votingPower) {
    votingPower = {
      rewardPoolId,
      account: voter,
      lastVoteTimestamp: timestamp,
      votingPower: MAX_VOTING_POWER,
      downvotingPower: MAX_VOTING_POWER,
    };
    votingPower = await api.db.insert('votingPower', votingPower);
  } else {
    // regenerate voting power
    votingPower.votingPower += (timestamp - votingPower.lastVoteTimestamp)
          / (rewardPool.config.voteRegenerationDays * 24 * 3600 * 1000);
    votingPower.votingPower = Math.floor(votingPower.votingPower);
    votingPower.votingPower = Math.min(votingPower.votingPower, MAX_VOTING_POWER);
    votingPower.downvotingPower += (timestamp - votingPower.lastVoteTimestamp)
          / (rewardPool.config.downvoteRegenerationDays * 24 * 3600 * 1000);
    votingPower.downvotingPower = Math.floor(votingPower.downvotingPower);
    votingPower.downvotingPower = Math.min(votingPower.downvotingPower, MAX_VOTING_POWER);
    votingPower.lastVoteTimestamp = timestamp;
  }

  const voterTokenBalance = await api.db.findOneInTable('tokens', 'balances', { symbol, account: voter });
  let stake = voterTokenBalance ? voterTokenBalance.stake : '0';
  if (voterTokenBalance && voterTokenBalance.delegationsIn
      && api.BigNumber(voterTokenBalance.delegationsIn).isFinite()) {
    stake = api.BigNumber(stake).plus(voterTokenBalance.delegationsIn);
  }

  let voteRshares = '0';
  let updatedPostRshares = '0';
  let usedPower = 0;
  let usedDownvotePower = 0;
  let curationWeight = '0';
  if (weight > 0) {
    voteRshares = api.BigNumber(stake).multipliedBy(weight).multipliedBy(votingPower.votingPower)
      .dividedBy(MAX_VOTING_POWER)
      .dividedBy(MAX_WEIGHT)
      .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    usedPower = Math.floor(votingPower.votingPower * Math.abs(weight) * 60 * 60 * 24 / MAX_WEIGHT);
    const usedPowerDenom = Math.floor(MAX_VOTING_POWER * 60 * 60 * 24
        / rewardPool.config.votePowerConsumption);
    usedPower = Math.floor((usedPower + usedPowerDenom - 1) / usedPowerDenom);
    api.debug(usedPower);
    votingPower.votingPower = Math.max(0, Math.floor(votingPower.votingPower - usedPower));
    curationWeight = api.BigNumber(calculateCurationWeightRshares(
      rewardPool, api.BigNumber(voteRshares).plus(post.votePositiveRshareSum),
    ))
      .minus(calculateCurationWeightRshares(rewardPool, post.votePositiveRshareSum))
      .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
  } else if (weight < 0) {
    voteRshares = api.BigNumber(stake).multipliedBy(weight)
      .multipliedBy(votingPower.downvotingPower)
      .dividedBy(MAX_VOTING_POWER)
      .dividedBy(MAX_WEIGHT)
      .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    usedDownvotePower = Math.floor(votingPower.downvotingPower * Math.abs(weight) * 60 * 60 * 24
        / MAX_WEIGHT);
    const usedDownvotePowerDenom = Math.floor(MAX_VOTING_POWER * 60 * 60 * 24
        / rewardPool.config.downvotePowerConsumption);
    usedDownvotePower = Math.floor((usedDownvotePower + usedDownvotePowerDenom - 1)
        / usedDownvotePowerDenom);
    votingPower.downvotingPower = Math.max(
      0, Math.floor(votingPower.downvotingPower - usedDownvotePower),
    );
  }

  api.debug(votingPower);
  await api.db.update('votingPower', votingPower);

  let vote = await api.db.findOne('votes', { rewardPoolId, authorperm, voter });
  if (vote) {
    // A re-vote negates curation rewards, similar to Hive.
    vote.timestamp = timestamp;
    vote.weight = weight;
    vote.curationWeight = '0';
    const oldVoteRshares = vote.rshares;
    vote.rshares = voteRshares;
    updatedPostRshares = api.BigNumber(voteRshares).minus(oldVoteRshares)
      .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    await api.db.update('votes', vote);
    api.emit('updateVote', { rewardPoolId, symbol: rewardPool.symbol, rshares: voteRshares });
  } else {
    vote = {
      rewardPoolId,
      symbol,
      authorperm,
      weight,
      rshares: voteRshares,
      curationWeight,
      timestamp,
      voter,
    };
    updatedPostRshares = voteRshares;
    await api.db.insert('votes', vote);
    api.emit('newVote', { rewardPoolId, symbol: rewardPool.symbol, rshares: voteRshares });
  }

  const oldPostClaims = calculateWeightRshares(rewardPool, post.voteRshareSum);
  // eslint-disable-next-line no-param-reassign
  post.voteRshareSum = api.BigNumber(post.voteRshareSum).plus(updatedPostRshares)
    .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
  // eslint-disable-next-line no-param-reassign
  post.scoreTrend = computeTrendScore(post);

  if (api.BigNumber(updatedPostRshares).gt(0)) {
    // eslint-disable-next-line no-param-reassign
    post.votePositiveRshareSum = api.BigNumber(post.votePositiveRshareSum).plus(updatedPostRshares)
      .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    if (timestamp < rewardPool.createdTimestamp
        + (2 * rewardPool.config.cashoutWindowDays + 1) * 24 * 3600 * 1000) {
      const newPostClaims = calculateWeightRshares(rewardPool, post.voteRshareSum);
      rewardPool.pendingClaims = api.BigNumber(rewardPool.pendingClaims)
        .plus(newPostClaims)
        .minus(oldPostClaims)
        .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
      await api.db.update('rewardPools', rewardPool);
      api.debug('updatin reward pool early section');
      api.debug(rewardPool);
    }
  }
  await api.db.update('posts', post);
}

actions.vote = async (payload) => {
  const {
    voter,
    author,
    permlink,
    weight,
  } = payload;
  await tokenMaintenance();

  // TODO: Handle separate direct voting action.
  if (!api.assert(api.sender === 'null', 'can only vote with voting op')) return;

  if (!api.assert(Number.isInteger(weight) && weight >= -10000 && weight <= 10000,
    'weight must be an integer from -10000 to 10000')) return;

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();
  const authorperm = `@${author}/${permlink}`;
  const posts = await api.db.find('posts', { authorperm });

  if (!api.assert(posts && posts.length > 0, 'post not found')) return;
  for (let i = 0; i < posts.length; i += 1) {
    const post = posts[i];
    await processVote(post, voter, weight, timestamp);
  }
};
