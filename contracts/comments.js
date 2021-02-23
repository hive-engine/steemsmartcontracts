/* eslint-disable no-await-in-loop */
/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
/* global actions, api */

const SMT_PRECISION = 10;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('rewardPools');
  if (tableExists === false) {
    await api.db.createTable('params');
    await api.db.createTable('rewardPools', ['symbol']);
    await api.db.createTable('posts', [
        'authorperm',
        { name: 'byCashoutTime', index: { 'rewardPoolId': 1, 'cashoutTime': 1 } },
        { name: 'byScoreTrend', index: { 'rewardPoolId': 1, 'scoreTrend': 1 } },
    ], { primaryKey: ['rewardPoolId', 'authorperm']);
    await api.db.createTable('votes', [{name: 'byTimestamp', index: {'rewardPoolId': 1, 'authorperm': 1, 'timestamp': 1}}], { primaryKey: ['rewardPoolId', 'authorperm', 'voter']);
    await api.db.createTable('votingPower', [], { primaryKey: ['rewardPoolId', 'account']});

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

actions.createRewardPool = async (payload) => {
    const {
        symbol,
        config,
        isSignedWithActiveKey,
    } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'operation must be signed with your active key')) {
    return;
  }
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: rewardPool.symbol });
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
    } = config;

    if (!api.assert(postRewardCurve && postRewardCurve !== 'power', 'postRewardCurve should be one of: [power]')) return;
    const postExponent = api.BigNumber(postRewardCurveParameter);
    if (!api.assert(postExponent.isFinite() && postExponent.gte("1") && postExponent.lte("2") && postExponent.dp() <= 2, 'postRewardCurveParameter should be between "1" and "2" with no more than 2 decimals')) return;

    if (!api.assert(curationRewardCurve && curationRewardCurve !== 'power', 'curationRewardCurve should be one of: [power]')) return;
    const curationExponent = api.BigNumber(curationRewardCurveParameter);
    if (!api.assert(curationExponent.isFinite() && curationExponent.gte("0.5") && curationExponent.lte("1") && curationExponent.dp() <= 2, 'curationRewardCurveParameter should be between "0.5" and "1" with no more than 2 decimals')) return;

    if (!api.assert(curationRewardPercentage && Number.isInteger(curationRewardPercentage) && curationRewardPercentage >= 0 && curationRewardPercentage <= 100, 'curationRewardPercentage should be an integer between 0 and 100')) return;

    if (!api.assert(cashoutWindowDays && Number.isInteger(cashoutWindowDays) && cashoutWindowDays >= 1 && cashoutWindowDays <= 30, 'cashoutWindowDays should be an integer between 1 and 30')) return;

    const parsedRewardPerBlock = api.BigNumber(rewardPerBlock);
    if (!api.assert(parsedRewardBlock.isFinite() && parsedRewardBlock.dp() <= token.precision && parsedRewardBlock.gt(0), 'rewardPerBlock invalid')
        || !api.assert(parsedRewardBlock.dp() <= token.precision, 'token precision mismatch for rewardPerBlock')) return;

    // for now, restrict to 1 pool per symbol, and creator must be issuer.
    if (!api.assert(api.sender === token.issuer, 'must be issuer of token')) return;
    
    const existingRewardPool = await api.db.findOne('rewardPools', { symbol });
    if (!api.assert(!existingRewardPool, 'cannot create multiple reward pools per token')) return;

    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();

    const rewardPool = {
        symbol,
        rewardPool: 0,
        lastRewardTimestamp: timestamp,
        config,
        pendingClaims: api.BigNumber(10).pow(token.precision + 10),
        active: true,
    };
    const insertedRewardPool = await api.db.insert('rewardPools', rewardPool);
    api.emit('createRewardPool', { _id: insertedRewardPool._id });
};

actions.comment = async (payload) => {
    const {
        author,
        permlink,
        rewardPools
    } = payload;

    // Node enforces author / permlinks from Hive. Check that sender is null.
    if (!api.assert(api.sender === 'null', 'action must use comment operation')) return;

    if (!api.assert(rewardPools && Array.isArray(rewardPools) && rewardPools.length > 0 && rewardPools.length <= 5, 'rewardPools must have length between 1 and 5')) return;

    const authorperm = `${author}${permlink}`;
    // Validate that comment is not an edit (cannot add multiple pools)
    const existingPost = await api.db.findOne('pools', { authorperm });
    if (!api.assert(!existingPost, 'cannot change reward configuration')) return;

    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();

    const post = {
        rewardPoolId,
        symbol,
        authorperm,
        author,
        cashoutTime,
        totalVoteWeight: 0,
        voteRshares: 0,
        scoreTrend: 0,
    };
    const insertedPost = await api.db.insert('posts', post);
};

actions.vote = async (payload) => {
    const {
        author,
        permlink,
        weight,
        rewardPoolId,
    } = payload;

    // allow two use cases-- regular vote, in which case it will look at all
    // available reward pools for the post, or with rewardPoolId, to target a
    // specific reward pool.
    
    if (!api.assert(api.sender === 'null' || rewardPoolId, 'can only vote with voting op or vote action with rewardPoolId')) return;
    if (rewardPoolId) {
      const rewardPool = await api.db.findOne('rewardPools', { _id: rewardPoolId });
        if (!api.assert(rewardPool, 'reward pool does not exist')) return;
    }

    if (!api.assert(weight && Number.isInteger(weight) && weight >= 0 && weight <= 10000, 'weight must be an integer from 0 to 10000')) return;

    // check voting power, stake, and current vote rshares.

    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();
    const authorperm = `${author}${permlink}`;

    const vote = {
        rewardPoolId,
        symbol,
        authorperm,
        author,
        cashoutTime,
        totalVoteWeight: 0,
        rshares: 0,
        scoreTrend: 0,
    };
    const insertedPost = api.db.insert('posts', post);
}

function calculateWeightRshares(rewardPool, voteRshares) {
    if (voteRshares < 0) return 0;
    if (rewardPool.config.postRewardCurve === 'power') {
        return api.BigNumber(voteRshares).pow(rewardPool.config.postRewardCurveParameter)
            .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    } else {
        return api.BigNumber(voteRshares);
    }
}

function isTokenTransferVerified(result, from, to, symbol, quantity) {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens' && el.event === 'transfer'
      && el.data.from === from && el.data.to === to && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
    return true;
  }
  return false;
}

async function payUser(symbol, amount, user) {
    const res = await api.transferTokens(user, symbol, amount, 'user');
    if (res.errors) {
        api.debug(`Error paying out ${amount} ${symbol} to ${user} (TXID ${api.transactionId}): \n${res.errors}`);
    }
}

async function payOutCurators(token, post, curatorPortion) {
    const {
        authorperm,
        symbol,
    } = post;
    let offset = 0;
    let votesToPayout = await api.db.find('votes', { authorperm, symbol }, 1000, offset, [{ index: 'timestamp', descending: false }, { index: '_id', descending: false }]);
    while (votesToPayout.length > 0) {
        for (let i = 0; i < votesToPayout.length; i += 1) {
            const vote = votesToPayout[i];
            if (api.BigNumber(vote.weight) > 0) {
                const votePay = curatorPortion.multipliedBy(vote.weight).dividedBy(post.totalVoteWeight).toFixed(token.precision, api.BigNumber.ROUND_DOWN);
                await payUser(symbol, votePay, vote.voter);
            }
        }
        offset += 1000;
        votesToPayout = await api.db.find('votes', { authorperm, symbol }, 1000, offset, [{ index: 'timestamp', descending: false }, { index: '_id', descending: false }]);
    }
}

async function payOutPost(rewardPool, token, post) {
    const postClaims = calculateWeightRshares(rewardPool, post.voteRshares);
    const postPendingToken = api.BigNumber(rewardPool.rewardPool).multipliedBy(postClaims)
        .dividedBy(newPendingClaims).toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    const curatorPortion = postPendingToken.multipliedBy(rewardPool.config.curationRewardPercentage).dividedBy(100)
        .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    const authorPortion = postPendingToken.minus(curatorPortion).toFixed(token.precision, api.BigNumber.ROUND_DOWN);
    post.lastPayout = timestamp;
    post.totalPayoutValue = postPendingToken;
    post.curatorPayoutValue = curatorPortion;
    post.scoreTrend = 0;

    await payOutCurators(token, post, curatorPortion);
    await payUser(symbol, authorPortion, post.author);
    await api.db.update('posts', post);
}

async function computePostRewards(params, rewardPool, token) {
    const {
        symbol,
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
  
    // pending claim decay
    let newPendingClaims = api.BigNumber(pendingClaims)
        .minus(api.BigNumber(pendingClaims)
            .multipliedBy(adjustNumer)
            .dividedBy(adjustDenom))
        .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN));

    // Add posts claims, compute subsequent rewards based on inclusion into claims to
    // ensure it cannot take more of the current pool
    const postsToPayout = await api.db.find('posts', { symbol, lastPayout: { $exists: false }, cashoutTime: { $lte: timestamp }}, maxPostsProcessedPerRound, 0, [{ index: 'cashoutTime', descending: false }, { index: '_id', descending: false }]);
   newPendingClaims = newPendingClaims.plus(
       postsToPayout.reduce((x,y) => y.plus(calculateWeightRshares(rewardPool, x.voteRshares)), api.BigNumber(0)))
       .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);

   let deductFromRewardPool = api.BigNumber(0);
   for (let i = 0; i < postsToPayout.length; i += 1) {
       const post = postsToPayout[i];
       await payOutPost(rewardPool, token, post);
       deductFromRewardPool = deductFromRewardPool.plus(post.totalPayoutValue);
   }
   rewardPool.pendingClaims = newPendingClaims;
}

async function tokenMaintenance() {
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();
    const params = await api.db.findOne('params', {});
    const { maintenanceTokensPerAction, maintenanceTokenOffset } = params;
    const rewardPools = await api.db.find('rewardPools', {}, maintenanceTokensPerAction, maintenanceTokenOffset)
    for (let i = 0; i < rewardPools.length; i += 1) {
        const rewardPool = rewardPools[i];
        const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: rewardPool.symbol });
        const rewardToAdd = api.BigNumber(rewardPool.config.rewardPerBlock)
                .multipliedBy(timestamp - rewardPool.lastRewardTimestamp)
                .dividedBy(1000)
                .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
        await api.executeSmartContract('tokens', 'issueToContract',
            { symbol: rewardPool.symbol, quantity: rewardToAdd, to: 'comments' });
        rewardPool.rewardPool = api.BigNumber(rewardPool).plus(rewardToAdd).toFixed(token.precision, api.BigNumber.ROUND_DOWN);
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
