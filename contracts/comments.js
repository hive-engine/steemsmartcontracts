/* eslint-disable no-await-in-loop */
/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
/* global actions, api */

const SMT_PRECISION = 10;
const MAX_VOTING_POWER = 10000;
const MAX_WEIGHT = 10000;
const POST_QUERY_LIMIT = 1000;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('rewardPools');
  if (tableExists === false) {
    await api.db.createTable('params');
    await api.db.createTable('rewardPools', ['config.tags', 'lastClaimDecayTimestamp']);
    await api.db.createTable('posts', [
      'authorperm',
      { name: 'byCashoutTime', index: { rewardPoolId: 1, cashoutTime: 1 } },
    ], { primaryKey: ['authorperm', 'rewardPoolId'] });
    await api.db.createTable('postMetadata', [], { primaryKey: ['authorperm'] });
    await api.db.createTable('votes', [{ name: 'byTimestamp', index: { rewardPoolId: 1, authorperm: 1, timestamp: 1 } }], { primaryKey: ['rewardPoolId', 'authorperm', 'voter'] });
    await api.db.createTable('votingPower', [], { primaryKey: ['rewardPoolId', 'account'] });

    const params = {
      setupFee: '1000',
      updateFee: '20',
      maxPoolsPerPost: 20,
      maxTagsPerPool: 5,
      maintenanceTokensPerBlock: 2,
      lastMaintenanceBlock: api.blockNumber,
      maxPostsProcessedPerRound: 20,
      voteQueryLimit: 100,
      maxVotesProcessedPerRound: 100,
      lastProcessedPoolId: 0,
    };
    await api.db.insert('params', params);
  } else {
    // Clean up after deployment
    await api.db.createTable('postMetadata', [], { primaryKey: ['authorperm'] });
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    setupFee,
    updateFee,
    maintenanceTokensPerBlock,
    maxPostsProcessedPerRound,
    maxVotesProcessedPerRound,
    voteQueryLimit,
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
  if (maintenanceTokensPerBlock) {
    if (!api.assert(Number.isInteger(maintenanceTokensPerBlock) && maintenanceTokensPerBlock >= 1, 'invalid maintenanceTokensPerBlock')) return;
    params.maintenanceTokensPerBlock = maintenanceTokensPerBlock;
  }
  if (maxPostsProcessedPerRound) {
    if (!api.assert(Number.isInteger(maxPostsProcessedPerRound) && maxPostsProcessedPerRound >= 1, 'invalid maxPostsProcessedPerRound')) return;
    params.maxPostsProcessedPerRound = maxPostsProcessedPerRound;
  }
  if (maxVotesProcessedPerRound) {
    if (!api.assert(Number.isInteger(maxVotesProcessedPerRound) && maxVotesProcessedPerRound >= 1, 'invalid maxVotesProcessedPerRound')) return;
    params.maxVotesProcessedPerRound = maxVotesProcessedPerRound;
  }
  if (voteQueryLimit) {
    if (!api.assert(Number.isInteger(voteQueryLimit) && voteQueryLimit >= 1, 'invalid voteQueryLimit')) return;
    params.voteQueryLimit = voteQueryLimit;
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

async function payUser(symbol, quantity, user, stakedRewardPercentage, mute) {
  if (mute) return;
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

async function getMute(rewardPoolId, account) {
  const votingPower = await api.db.findOne('votingPower', { rewardPoolId, account });
  return votingPower ? votingPower.mute : false;
}

async function payOutBeneficiaries(rewardPool, token, post, authorBenePortion) {
  const {
    authorperm,
    symbol,
    rewardPoolId,
    beneficiaries,
  } = post;
  if (!beneficiaries || beneficiaries.length === 0) {
    return api.BigNumber(0);
  }
  let totalBenePay = api.BigNumber(0);
  for (let i = 0; i < beneficiaries.length; i += 1) {
    const beneficiary = beneficiaries[i];
    const benePay = api.BigNumber(authorBenePortion).multipliedBy(beneficiary.weight)
      .dividedBy(10000)
      .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
    const mute = await getMute(rewardPoolId, beneficiary.account);
    const rewardLog = {
      rewardPoolId, authorperm, symbol, account: beneficiary.account, quantity: benePay,
    };
    if (mute) {
      rewardLog.mute = true;
    }
    api.emit('beneficiaryReward', rewardLog);
    await payUser(symbol, benePay, beneficiary.account, rewardPool.config.stakedRewardPercentage,
      mute);
    totalBenePay = api.BigNumber(totalBenePay).plus(benePay);
  }
  return totalBenePay;
}

async function payOutCurators(rewardPool, token, post, curatorPortion, params) {
  const {
    authorperm,
    symbol,
    rewardPoolId,
  } = post;
  const {
    voteQueryLimit,
  } = params;
  const response = {
    done: false,
    votesProcessed: 0,
  };
  const votesToPayout = await api.db.find('votes', { rewardPoolId, authorperm }, voteQueryLimit, 0, [{ index: 'byTimestamp', descending: false }]);
  if (votesToPayout.length === 0) {
    response.done = true;
  } else {
    for (let i = 0; i < votesToPayout.length; i += 1) {
      const vote = votesToPayout[i];
      if (api.BigNumber(vote.curationWeight) > 0) {
        const totalCurationWeight = calculateCurationWeightRshares(
          rewardPool, post.votePositiveRshareSum,
        );
        const votePay = api.BigNumber(curatorPortion).multipliedBy(vote.curationWeight)
          .dividedBy(totalCurationWeight)
          .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
        const mute = await getMute(rewardPoolId, vote.voter);
        const rewardLog = {
          rewardPoolId, authorperm, symbol, account: vote.voter, quantity: votePay,
        };
        if (mute) {
          rewardLog.mute = true;
        }
        api.emit('curationReward', rewardLog);
        await payUser(symbol, votePay, vote.voter, rewardPool.config.stakedRewardPercentage, mute);
      }
      await api.db.remove('votes', vote);
    }
    response.votesProcessed += votesToPayout.length;
    if (votesToPayout.length < voteQueryLimit) {
      response.done = true;
    }
  }
  return response;
}

async function payOutPost(rewardPool, token, post, params) {
  const response = {
    totalPayoutValue: 0,
    votesProcessed: 0,
    done: false,
  };
  if (post.declinePayout) {
    api.emit('authorReward', {
      rewardPoolId: post.rewardPoolId,
      authorperm: post.authorperm,
      symbol: post.symbol,
      account: post.author,
      quantity: '0',
    });
    response.done = true;
    await api.db.remove('posts', post);
    return response;
  }
  const postClaims = calculateWeightRshares(rewardPool, post.voteRshareSum);
  const postPendingToken = api.BigNumber(rewardPool.intervalPendingClaims).gt(0)
    ? api.BigNumber(rewardPool.intervalRewardPool).multipliedBy(postClaims)
      .dividedBy(rewardPool.intervalPendingClaims)
      .toFixed(token.precision, api.BigNumber.ROUND_DOWN)
    : '0';
  response.totalPayoutValue = postPendingToken;

  const curatorPortion = api.BigNumber(postPendingToken)
    .multipliedBy(rewardPool.config.curationRewardPercentage)
    .dividedBy(100)
    .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
  const authorBenePortion = api.BigNumber(postPendingToken).minus(curatorPortion)
    .toFixed(token.precision, api.BigNumber.ROUND_DOWN);

  const beneficiariesPayoutValue = await payOutBeneficiaries(
    rewardPool, token, post, authorBenePortion,
  );
  const authorPortion = api.BigNumber(authorBenePortion).minus(beneficiariesPayoutValue)
    .toFixed(token.precision, api.BigNumber.ROUND_DOWN);

  const curatorPayStatus = await payOutCurators(rewardPool, token, post, curatorPortion, params);
  response.votesProcessed += curatorPayStatus.votesProcessed;
  response.done = curatorPayStatus.done;
  if (curatorPayStatus.done) {
    const mute = await getMute(post.rewardPoolId, post.author);
    const rewardLog = {
      rewardPoolId: post.rewardPoolId,
      authorperm: post.authorperm,
      symbol: post.symbol,
      account: post.author,
      quantity: authorPortion,
    };
    if (mute) {
      rewardLog.mute = true;
    }
    api.emit('authorReward', rewardLog);
    await payUser(post.symbol, authorPortion, post.author,
      rewardPool.config.stakedRewardPercentage, mute);
    await api.db.remove('posts', post);
  }
  return response;
}

async function computePostRewards(params, rewardPool, token, endTimestamp) {
  const {
    lastClaimDecayTimestamp,
  } = rewardPool;
  const {
    maxPostsProcessedPerRound,
    maxVotesProcessedPerRound,
  } = params;

  const postsToPayout = await api.db.find('posts',
    {
      rewardPoolId: rewardPool._id,
      cashoutTime: { $gte: lastClaimDecayTimestamp, $lte: endTimestamp },
    },
    maxPostsProcessedPerRound,
    0,
    [{ index: 'byCashoutTime', descending: false }, { index: '_id', descending: false }]);
  let done = false;
  let deductFromRewardPool = api.BigNumber(0);
  let votesProcessed = 0;
  if (postsToPayout && postsToPayout.length > 0) {
    let limitReached = false;
    for (let i = 0; i < postsToPayout.length; i += 1) {
      const post = postsToPayout[i];
      const postPayoutResponse = await payOutPost(rewardPool, token, post, params);
      const { totalPayoutValue } = postPayoutResponse;
      votesProcessed += postPayoutResponse.votesProcessed;
      if (postPayoutResponse.done) {
        deductFromRewardPool = deductFromRewardPool.plus(totalPayoutValue);
      }
      if (!postPayoutResponse.done || votesProcessed >= maxVotesProcessedPerRound) {
        limitReached = true;
        break;
      }
    }
    if (!limitReached && postsToPayout.length < maxPostsProcessedPerRound) {
      done = true;
    }
    // eslint-disable-next-line no-param-reassign
    rewardPool.rewardPool = api.BigNumber(rewardPool.rewardPool)
      .minus(deductFromRewardPool)
      .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
  } else {
    done = true;
  }
  if (done) {
    // eslint-disable-next-line no-param-reassign
    rewardPool.lastClaimDecayTimestamp = endTimestamp;
  }
}

async function postClaimsInInterval(params, rewardPool, start, end) {
  let postOffset = 0;
  let newPendingClaims = api.BigNumber(0);
  let postsToPayout = await api.db.find('posts',
    {
      rewardPoolId: rewardPool._id,
      cashoutTime: { $gte: start, $lte: end },
    },
    POST_QUERY_LIMIT,
    postOffset,
    [{ index: 'byCashoutTime', descending: false }, { index: '_id', descending: false }]);
  while (postsToPayout && postsToPayout.length > 0) {
    newPendingClaims = newPendingClaims.plus(
      postsToPayout.reduce((x, y) => x.plus(calculateWeightRshares(rewardPool, y.voteRshareSum)),
        api.BigNumber(0)),
    )
      .dp(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    if (postsToPayout.length < POST_QUERY_LIMIT) {
      break;
    }
    postOffset += POST_QUERY_LIMIT;
    postsToPayout = await api.db.find('posts',
      {
        rewardPoolId: rewardPool._id,
        cashoutTime: { $gte: start, $lte: end },
      },
      POST_QUERY_LIMIT,
      postOffset,
      [{ index: 'byCashoutTime', descending: false }, { index: '_id', descending: false }]);
  }
  return newPendingClaims;
}

async function tokenMaintenance() {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();
  const params = await api.db.findOne('params', {});
  const { lastMaintenanceBlock, lastProcessedPoolId, maintenanceTokensPerBlock } = params;
  if (lastMaintenanceBlock >= api.blockNumber) {
    return;
  }
  params.lastMaintenanceBlock = api.blockNumber;

  // Checks if ready to process next reward interval
  const rewardPoolProcessingExpression = {
    $lte: [
      '$lastClaimDecayTimestamp',
      {
        $subtract: [
          timestamp,
          {
            $multiply: [
              '$config.rewardIntervalSeconds',
              1000,
            ],
          },
        ],
      },
    ],
  };
  let rewardPools = await api.db.find('rewardPools', {
    active: true,
    $expr: rewardPoolProcessingExpression,
    _id: { $gt: lastProcessedPoolId },
  }, maintenanceTokensPerBlock, 0, [{ index: '_id', descending: false }]);
  if (!rewardPools || rewardPools.length < maintenanceTokensPerBlock) {
    if (!rewardPools) {
      rewardPools = [];
    }
    // augment from beginning
    const moreRewardPools = await api.db.find('rewardPools', {
      active: true,
      $expr: rewardPoolProcessingExpression,
    }, maintenanceTokensPerBlock - rewardPools.length, 0, [{ index: '_id', descending: false }]);
    const existingIds = new Set(rewardPools.map(p => p._id));
    moreRewardPools.forEach((mrp) => {
      if (!existingIds.has(mrp._id)) {
        rewardPools.push(mrp);
      }
    });
  }
  if (rewardPools) {
    for (let i = 0; i < rewardPools.length; i += 1) {
      const rewardPool = rewardPools[i];
      params.lastProcessedPoolId = rewardPool._id;
      const {
        symbol,
        lastClaimDecayTimestamp,
        lastRewardTimestamp,
        config,
      } = rewardPool;
      const {
        rewardIntervalSeconds,
        rewardPerInterval,
        cashoutWindowDays,
      } = config;
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
      const rewardIntervalDurationMillis = rewardIntervalSeconds * 1000;
      const nextRewardTimestamp = lastRewardTimestamp + rewardIntervalDurationMillis;
      const nextClaimDecayTimestamp = lastClaimDecayTimestamp + rewardIntervalDurationMillis;
      if (nextClaimDecayTimestamp >= nextRewardTimestamp) {
        const rewardToAdd = api.BigNumber(rewardPerInterval);
        if (api.BigNumber(rewardToAdd).gt(0)) {
          await api.executeSmartContract('tokens', 'issueToContract',
            {
              symbol: rewardPool.symbol, quantity: rewardToAdd, to: 'comments', isSignedWithActiveKey: true,
            });
          rewardPool.rewardPool = api.BigNumber(rewardPool.rewardPool).plus(rewardToAdd)
            .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
        }
        // claim adjustments (decay + posts to pay out in next interval)
        const claimsDecayPeriodDays = cashoutWindowDays * 2 + 1;
        const adjustNumer = nextRewardTimestamp - lastRewardTimestamp;
        const adjustDenom = claimsDecayPeriodDays * 24 * 3600 * 1000;
        // eslint-disable-next-line no-param-reassign
        rewardPool.pendingClaims = api.BigNumber(rewardPool.pendingClaims)
          .minus(api.BigNumber(rewardPool.pendingClaims)
            .multipliedBy(adjustNumer)
            .dividedBy(adjustDenom))
          .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
        // Add posts claims, compute subsequent rewards based on inclusion into claims to
        // ensure it cannot take more of the current pool
        rewardPool.pendingClaims = api.BigNumber(rewardPool.pendingClaims)
          .plus(
            await postClaimsInInterval(
              params, rewardPool, lastRewardTimestamp, nextRewardTimestamp,
            ),
          )
          .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);

        rewardPool.lastRewardTimestamp = nextRewardTimestamp;
        // copy claims and rewards for current reward interval
        rewardPool.intervalPendingClaims = rewardPool.pendingClaims;
        rewardPool.intervalRewardPool = rewardPool.rewardPool;
      }
      // Compute post rewards
      await computePostRewards(params, rewardPool, token, nextClaimDecayTimestamp);
      await api.db.update('rewardPools', rewardPool);
    }
  }
  await api.db.update('params', params);
}

actions.createRewardPool = async (payload) => {
  const {
    symbol,
    config,
    isSignedWithActiveKey,
  } = payload;
  if (!api.assert(isSignedWithActiveKey === true, 'operation must be signed with your active key')) {
    return;
  }

  const params = await api.db.findOne('params', {});
  const { setupFee, maxTagsPerPool } = params;

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
    rewardPerInterval,
    rewardIntervalSeconds,
    voteRegenerationDays,
    downvoteRegenerationDays,
    stakedRewardPercentage,
    votePowerConsumption,
    downvotePowerConsumption,
    tags,
  } = config;

  if (!api.assert(postRewardCurve && postRewardCurve === 'power', 'postRewardCurve should be one of: [power]')) return;
  const postExponent = api.BigNumber(postRewardCurveParameter);
  if (!api.assert(typeof postRewardCurveParameter === 'string' && postExponent.isFinite() && postExponent.gte('1') && postExponent.lte('2') && postExponent.dp() <= 2, 'postRewardCurveParameter should be between "1" and "2" with precision at most 2')) return;

  if (!api.assert(curationRewardCurve && curationRewardCurve === 'power', 'curationRewardCurve should be one of: [power]')) return;
  const curationExponent = api.BigNumber(curationRewardCurveParameter);
  if (!api.assert(typeof curationRewardCurveParameter === 'string' && curationExponent.isFinite() && curationExponent.gte('0.5') && curationExponent.lte('1') && curationExponent.dp() <= 2, 'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2')) return;

  if (!api.assert(Number.isInteger(curationRewardPercentage) && curationRewardPercentage >= 0 && curationRewardPercentage <= 100, 'curationRewardPercentage should be an integer between 0 and 100')) return;

  if (!api.assert(cashoutWindowDays && Number.isInteger(cashoutWindowDays) && cashoutWindowDays >= 1 && cashoutWindowDays <= 30, 'cashoutWindowDays should be an integer between 1 and 30')) return;

  const parsedRewardPerInterval = api.BigNumber(rewardPerInterval);
  if (!api.assert(typeof rewardPerInterval === 'string' && parsedRewardPerInterval.isFinite() && parsedRewardPerInterval.gt(0), 'rewardPerInterval invalid')
        || !api.assert(parsedRewardPerInterval.dp() <= token.precision, 'token precision mismatch for rewardPerInterval')) return;

  if (!api.assert(rewardIntervalSeconds && Number.isInteger(rewardIntervalSeconds) && rewardIntervalSeconds >= 3 && rewardIntervalSeconds <= 86400 && rewardIntervalSeconds % 3 === 0, 'rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3')) return;

  if (!api.assert(voteRegenerationDays && Number.isInteger(voteRegenerationDays) && voteRegenerationDays >= 1 && voteRegenerationDays <= 30, 'voteRegenerationDays should be an integer between 1 and 30')) return;
  if (!api.assert(downvoteRegenerationDays && Number.isInteger(downvoteRegenerationDays) && downvoteRegenerationDays >= 1 && downvoteRegenerationDays <= 30, 'downvoteRegenerationDays should be an integer between 1 and 30')) return;
  if (!api.assert(Number.isInteger(stakedRewardPercentage) && stakedRewardPercentage >= 0 && stakedRewardPercentage <= 100, 'stakedRewardPercentage should be an integer between 0 and 100')) return;
  if (!api.assert(votePowerConsumption && Number.isInteger(votePowerConsumption) && votePowerConsumption >= 1 && votePowerConsumption <= 10000, 'votePowerConsumption should be an integer between 1 and 10000')) return;
  if (!api.assert(downvotePowerConsumption && Number.isInteger(downvotePowerConsumption) && downvotePowerConsumption >= 1 && downvotePowerConsumption <= 10000, 'downvotePowerConsumption should be an integer between 1 and 10000')) return;

  if (!api.assert(Array.isArray(tags) && tags.length >= 1 && tags.length <= maxTagsPerPool && tags.every(t => typeof t === 'string'), `tags should be a non-empty array of strings of length at most ${maxTagsPerPool}`)) return;

  // for now, restrict to 1 pool per symbol, and creator must be issuer.
  // eslint-disable-next-line no-template-curly-in-string
  if (!api.assert(api.sender === token.issuer || (api.sender === api.owner && token.symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'"), 'must be issuer of token')) return;
  if (!api.assert(token.stakingEnabled, 'token must have staking enabled')) return;

  const existingRewardPool = await api.db.findOne('rewardPools', { symbol });
  if (!api.assert(!existingRewardPool, 'cannot create multiple reward pools per token')) return;

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();

  const rewardPool = {
    symbol,
    rewardPool: '0',
    lastRewardTimestamp: timestamp,
    lastClaimDecayTimestamp: timestamp,
    createdTimestamp: timestamp,
    config: {
      postRewardCurve,
      postRewardCurveParameter,
      curationRewardCurve,
      curationRewardCurveParameter,
      curationRewardPercentage,
      cashoutWindowDays,
      rewardPerInterval,
      rewardIntervalSeconds,
      voteRegenerationDays,
      downvoteRegenerationDays,
      stakedRewardPercentage,
      votePowerConsumption,
      downvotePowerConsumption,
      tags,
    },
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
  if (!api.assert(isSignedWithActiveKey === true, 'operation must be signed with your active key')) {
    return;
  }
  // get contract params
  const params = await api.db.findOne('params', {});
  const { updateFee, maxTagsPerPool } = params;
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
    rewardPerInterval,
    rewardIntervalSeconds,
    voteRegenerationDays,
    downvoteRegenerationDays,
    stakedRewardPercentage,
    votePowerConsumption,
    downvotePowerConsumption,
    tags,
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

  if (!api.assert(Number.isInteger(curationRewardPercentage) && curationRewardPercentage >= 0 && curationRewardPercentage <= 100, 'curationRewardPercentage should be an integer between 0 and 100')) return;
  existingRewardPool.config.curationRewardPercentage = curationRewardPercentage;

  if (!api.assert(cashoutWindowDays && Number.isInteger(cashoutWindowDays) && cashoutWindowDays >= 1 && cashoutWindowDays <= 30, 'cashoutWindowDays should be an integer between 1 and 30')) return;
  existingRewardPool.config.cashoutWindowDays = cashoutWindowDays;

  const parsedRewardPerInterval = api.BigNumber(rewardPerInterval);
  if (!api.assert(typeof rewardPerInterval === 'string' && parsedRewardPerInterval.isFinite() && parsedRewardPerInterval.gt(0), 'rewardPerInterval invalid')
        || !api.assert(parsedRewardPerInterval.dp() <= token.precision, 'token precision mismatch for rewardPerInterval')) return;
  existingRewardPool.config.rewardPerInterval = rewardPerInterval;

  if (!api.assert(rewardIntervalSeconds && Number.isInteger(rewardIntervalSeconds) && rewardIntervalSeconds >= 3 && rewardIntervalSeconds <= 86400 && rewardIntervalSeconds % 3 === 0, 'rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3')) return;
  existingRewardPool.config.rewardIntervalSeconds = rewardIntervalSeconds;

  if (!api.assert(voteRegenerationDays && Number.isInteger(voteRegenerationDays) && voteRegenerationDays >= 1 && voteRegenerationDays <= 30, 'voteRegenerationDays should be an integer between 1 and 30')) return;
  existingRewardPool.config.voteRegenerationDays = voteRegenerationDays;

  if (!api.assert(downvoteRegenerationDays && Number.isInteger(downvoteRegenerationDays) && downvoteRegenerationDays >= 1 && downvoteRegenerationDays <= 30, 'downvoteRegenerationDays should be an integer between 1 and 30')) return;
  existingRewardPool.config.downvoteRegenerationDays = downvoteRegenerationDays;

  if (!api.assert(Number.isInteger(stakedRewardPercentage) && stakedRewardPercentage >= 0 && stakedRewardPercentage <= 100, 'stakedRewardPercentage should be an integer between 0 and 100')) return;
  existingRewardPool.config.stakedRewardPercentage = stakedRewardPercentage;

  if (!api.assert(votePowerConsumption && Number.isInteger(votePowerConsumption) && votePowerConsumption >= 1 && votePowerConsumption <= 10000, 'votePowerConsumption should be an integer between 1 and 10000')) return;
  existingRewardPool.config.votePowerConsumption = votePowerConsumption;

  if (!api.assert(downvotePowerConsumption && Number.isInteger(downvotePowerConsumption) && downvotePowerConsumption >= 1 && downvotePowerConsumption <= 10000, 'downvotePowerConsumption should be an integer between 1 and 10000')) return;
  existingRewardPool.config.downvotePowerConsumption = downvotePowerConsumption;

  if (!api.assert(Array.isArray(tags) && tags.length >= 1 && tags.length <= maxTagsPerPool && tags.every(t => typeof t === 'string'), `tags should be a non-empty array of strings of length at most ${maxTagsPerPool}`)) return;
  existingRewardPool.config.tags = tags;

  // eslint-disable-next-line no-template-curly-in-string
  if (!api.assert(api.sender === token.issuer || (api.sender === api.owner && token.symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'"), 'must be issuer of token')) return;

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
  if (!api.assert(isSignedWithActiveKey === true, 'operation must be signed with your active key')) {
    return;
  }

  const existingRewardPool = await api.db.findOne('rewardPools', { _id: rewardPoolId });
  if (!api.assert(existingRewardPool, 'reward pool not found')) return;
  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: existingRewardPool.symbol });
  if (!api.assert(api.sender === token.issuer || api.sender === api.owner, 'must be issuer of token')) return;

  existingRewardPool.active = active;
  await api.db.update('rewardPools', existingRewardPool);
};

actions.setMute = async (payload) => {
  const {
    rewardPoolId,
    account,
    mute,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'operation must be signed with your active key')) {
    return;
  }
  const existingRewardPool = await api.db.findOne('rewardPools', { _id: rewardPoolId });
  if (!api.assert(existingRewardPool, 'reward pool not found')) return;
  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: existingRewardPool.symbol });
  if (!api.assert(api.sender === token.issuer || api.sender === api.owner, 'must be issuer of token')) return;
  if (!api.assert(api.isValidAccountName(account), 'invalid account')) return;
  if (!api.assert(typeof mute === 'boolean', 'mute must be a boolean')) return;

  const votingPower = await api.db.findOne('votingPower', { rewardPoolId, account });
  if (!votingPower) {
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();
    const newVotingPower = {
      rewardPoolId,
      account,
      lastVoteTimestamp: timestamp,
      votingPower: MAX_VOTING_POWER,
      downvotingPower: MAX_VOTING_POWER,
      mute,
    };
    await api.db.insert('votingPower', newVotingPower);
  } else {
    votingPower.mute = mute;
    await api.db.update('votingPower', votingPower);
  }
};

async function getRewardPoolIds(payload) {
  const {
    rewardPools,
    jsonMetadata,
    parentAuthor,
    parentPermlink,
  } = payload;

  const params = await api.db.findOne('params', {});

  // Check if it is a reply, and inherit the settings
  // from the parent.
  if (parentAuthor && parentPermlink) {
    const parentAuthorperm = `@${parentAuthor}/${parentPermlink}`;
    const parentPostMetadata = await api.db.findOne('postMetadata', { authorperm: parentAuthorperm });
    if (parentPostMetadata) {
      return parentPostMetadata.rewardPoolIds;
    }
    // Can only return params.maxPoolsPerPost (<1000) posts
    const parentPosts = await api.db.find('posts', { authorperm: parentAuthorperm });
    if (parentPosts && parentPosts.length > 0) {
      return parentPosts.map(p => p.rewardPoolId);
    }
    return [];
  }
  // Check metadata for tags / parent permlink
  // for community.
  if (jsonMetadata && jsonMetadata.tags && Array.isArray(jsonMetadata.tags)
      && jsonMetadata.tags.every(t => typeof t === 'string')) {
    const searchTags = parentPermlink ? jsonMetadata.tags.concat([parentPermlink])
      : jsonMetadata.tags;
    const tagRewardPools = await api.db.find('rewardPools',
      { 'config.tags': { $in: searchTags } },
      params.maxPoolsPerPost, 0, [{ index: '_id', descending: false }]);
    if (tagRewardPools && tagRewardPools.length > 0) {
      return tagRewardPools.map(r => r._id);
    }
  }
  if (rewardPools && Array.isArray(rewardPools) && rewardPools.length > 0) {
    return rewardPools.slice(0, params.maxPoolsPerPost);
  }
  return [];
}

actions.comment = async (payload) => {
  const {
    author,
    permlink,
    rewardPools,
  } = payload;

  // Node enforces author / permlinks from Hive. Check that sender is null.
  if (!api.assert(api.sender === 'null', 'action must use comment operation')) return;
  await tokenMaintenance();

  if (!api.assert(!rewardPools || (Array.isArray(rewardPools) && rewardPools.every(rp => Number.isInteger(rp))), 'rewardPools must be an array of integers')) return;

  const rewardPoolIds = await getRewardPoolIds(payload);
  const authorperm = `@${author}/${permlink}`;

  // Validate that comment is not an edit (cannot add multiple pools)
  const existingPost = await api.db.findOne('postMetadata', { authorperm });
  if (existingPost) {
    return;
  }
  // Tracks whether we have seen this authorperm before
  await api.db.insert('postMetadata', { authorperm, rewardPoolIds });

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();
  for (let i = 0; i < rewardPoolIds.length; i += 1) {
    const rewardPoolId = rewardPoolIds[i];
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
      };
      await api.db.insert('posts', post);
      api.emit('newComment', { rewardPoolId, symbol: rewardPool.symbol });
    }
  }
};

actions.commentOptions = async (payload) => {
  const {
    author,
    permlink,
    maxAcceptedPayout,
    beneficiaries,
  } = payload;

  // Node enforces author / permlinks from Hive. Check that sender is null.
  if (!api.assert(api.sender === 'null', 'action must use commentOptions operation')) return;
  const authorperm = `@${author}/${permlink}`;

  const existingPosts = await api.db.find('posts', { authorperm });
  if (!existingPosts) {
    return;
  }

  const declinePayout = maxAcceptedPayout.startsWith('0.000');
  for (let i = 0; i < existingPosts.length; i += 1) {
    const post = existingPosts[i];
    post.declinePayout = declinePayout;
    post.beneficiaries = beneficiaries;
    await api.db.update('posts', post);
  }
};

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
    votingPower.votingPower += (timestamp - votingPower.lastVoteTimestamp) * MAX_VOTING_POWER
          / (rewardPool.config.voteRegenerationDays * 24 * 3600 * 1000);
    votingPower.votingPower = Math.floor(votingPower.votingPower);
    votingPower.votingPower = Math.min(votingPower.votingPower, MAX_VOTING_POWER);
    votingPower.downvotingPower += (timestamp - votingPower.lastVoteTimestamp) * MAX_VOTING_POWER
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

  if (votingPower.mute) {
    voteRshares = '0';
    curationWeight = '0';
  }

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
    const voteLog = { rewardPoolId, symbol: rewardPool.symbol, rshares: voteRshares };
    if (votingPower.mute) {
      voteLog.mute = true;
    }
    api.emit('updateVote', voteLog);
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
    const voteLog = { rewardPoolId, symbol: rewardPool.symbol, rshares: voteRshares };
    if (votingPower.mute) {
      voteLog.mute = true;
    }
    api.emit('newVote', voteLog);
  }

  const oldPostClaims = calculateWeightRshares(rewardPool, post.voteRshareSum);
  // eslint-disable-next-line no-param-reassign
  post.voteRshareSum = api.BigNumber(post.voteRshareSum).plus(updatedPostRshares)
    .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);

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

  if (!api.assert(api.sender === 'null', 'can only vote with voting op')) return;
  await tokenMaintenance();

  if (!api.assert(Number.isInteger(weight) && weight >= -10000 && weight <= 10000,
    'weight must be an integer from -10000 to 10000')) return;

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();
  const authorperm = `@${author}/${permlink}`;
  // Can only return params.maxPoolsPerPost (<1000) posts
  const posts = await api.db.find('posts', { authorperm });

  if (!posts) return;
  for (let i = 0; i < posts.length; i += 1) {
    const post = posts[i];
    await processVote(post, voter, weight, timestamp);
  }
};
