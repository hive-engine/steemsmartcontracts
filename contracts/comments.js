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
  await tokenMaintenance();
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
        voteRegenerationDays,
        downvoteRegenerationDays,
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

    if (!api.assert(voteRegenerationDays && Number.isInteger(voteRegenerationDays) && voteRegenerationDays >= 1 && voteRegenerationDays <= 30, 'voteRegenerationDays should be an integer between 1 and 30')) return;
    if (!api.assert(downvoteRegenerationDays && Number.isInteger(downvoteRegenerationDays) && downvoteRegenerationDays >= 1 && downvoteRegenerationDays <= 30, 'downvoteRegenerationDays should be an integer between 1 and 30')) return;

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

    await tokenMaintenance();
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
        votePositiveRshareSum: 0,
        voteRshareSum: 0,
        scoreTrend: 0,
    };
    const insertedPost = await api.db.insert('posts', post);
};

async function processVote(post, voter, weight, timestamp) {
    const {
        rewardPoolId,
        symbol,
        authorperm,
    } = post;

    // check voting power, stake, and current vote rshares.
    const rewardPool = await api.db.findOne('rewardPools', { _id: rewardPoolId });
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
        votingPower.votingPower += (timestamp - votingPower.lastVoteTimestamp) / (rewardPool.config.voteRegenerationDays * 24 * 3600 * 1000);
        votingPower.votingPower = Math.max(votingPower.votingPower, MAX_VOTING_POWER);
        votingPower.downvotingPower += (timestamp - votingPower.lastVoteTimestamp) / (rewardPool.config.downvoteRegenerationDays * 24 * 3600 * 1000);
        votingPower.downvotingPower = Math.max(votingPower.downvotingPower, MAX_VOTING_POWER);
        votingPower.lastVoteTimestamp = timestamp;
    }

    const voterTokenBalance = await api.db.findOneInTable('tokens', 'balances', { symbol, account: voter });
    const stake = voterTokenBalance.stake;

    let rshares = 0;
    let usedPower = 0;
    let usedDownvotePower = 0;
    let curationWeight = "0";
    if (weight > 0) {
        rshares = api.BigNumber(stake).multipliedBy(weight).multipliedBy(votingPower.votingPower).dividedBy(MAX_VOTING_POWER).dividedBy(MAX_WEIGHT);
        usedPower = Math.floor(votingPower.votingPower * weight * 60*60*24 / MAX_WEIGHT);
        const usedPowerDenom = Math.floor(MAX_VOTING_POWER * 60*60*24 / votePowerConsumption);
        usedPower = Math.floor((usedPower + usedPowerDenom - 1) / usedPowerDenom);
        votingPower.votingPower = Math.max(0, votingPower.votingPower - usedPower);
        curationWeight = calculateCurationWeightRshares(rewardPool, rshares.plus(post.votePositiveRshareSum))
            .minus(calculateCurationWeightRshares(rewardPool, post.votePositiveRshareSum))
            .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    } else if (weight < 0) {
        rshares = api.BigNumber(stake).multipliedBy(weight).multipliedBy(votingPower.downvotingPower).dividedBy(MAX_VOTING_POWER).dividedBy(MAX_WEIGHT);
        usedDownvotePower = Math.floor(votingPower.downvotingPower * weight * 60*60*24 / MAX_WEIGHT);
        const usedDownvotePowerDenom = Math.floor(MAX_VOTING_POWER * 60*60*24 / downvotePowerConsumption);
        usedDownvotePower = Math.floor((usedDownvotePower + usedPowerDenom - 1) / usedDownvotePowerDenom);
        votingPower.downvotingPower = Math.max(0, votingPower.downvotingPower - usedDownvotePower);
    }

    await api.db.update('votingPower', votingPower);

    let vote = await api.db.findOne('votes', { rewardPoolId, authorperm, voter }); 
    if (vote) {
        // A re-vote negates curation rewards, similar to Hive.
        vote.timestamp = timestamp;
        vote.weight = weight;
        vote.curationWeight = "0";
        rshares = rshares.minus(vote.rshares);
        await api.db.update('votes', vote);
    } else {
        vote = {
            rewardPoolId,
            symbol,
            authorperm,
            weight,
            rshares,
            curationWeight,
            timestamp,
        };
        await api.db.insert('votes', vote);
    }

    post.voteRshareSum = api.BigNumber(post.voteRshareSum).plus(rshares);
    if (rshares > 0) {
        post.votePositiveRshareSum = api.BigNumber(post.votePositiveRshareSum).plus(rshares);
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

    // If we want to look into allowing a custom op voting on individual reward pools, the power computation
    // needs to take into account the infinite voting exploit at the small voting power scale.
    // Hive handles this by a tax on voting power + vote dust threshold.
    if (!api.assert(api.sender === 'null', 'can only vote with voting op')) return;

    if (!api.assert(weight && Number.isInteger(weight) && weight >= 0 && weight <= 10000, 'weight must be an integer from 0 to 10000')) return;

    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();
    const authorperm = `${author}${permlink}`;
    const posts = await api.db.find('posts', { authorperm });
    for (let i = 0; i < posts.length; i += 1) {
        const post = posts[i];
        await processVote(post, voter, weight, timestamp);
    }
}


function calculateWeightRshares(rewardPool, voteRshareSum) {
    if (api.BigNumber(voteRshareSum).lte(0)) return api.BigNumber(0);
    if (rewardPool.config.postRewardCurve === 'power') {
        return api.BigNumber(voteRshareSum).pow(rewardPool.config.postRewardCurveParameter)
            .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    } else {
        return api.BigNumber(voteRshareSum);
    }
}

function calculateCurationWeightRshares(rewardPool, voteRshareSum) {
    if (api.BigNumber(voteRshareSum).lte(0)) return api.BigNumber(0);
    if (rewardPool.config.curationRewardCurve === 'power') {
        return api.BigNumber(voteRshareSum).pow(rewardPool.config.curationRewardCurveParameter)
            .toFixed(SMT_PRECISION, api.BigNumber.ROUND_DOWN);
    } else {
        return api.BigNumber(voteRshareSum);
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
        rewardPoolId,
    } = post;
    let offset = 0;
    let votesToPayout = await api.db.find('votes', { authorperm, symbol, rewardPoolId }, 1000, offset, [{ index: 'timestamp', descending: false }, { index: '_id', descending: false }]);
    while (votesToPayout.length > 0) {
        for (let i = 0; i < votesToPayout.length; i += 1) {
            const vote = votesToPayout[i];
            if (api.BigNumber(vote.weight) > 0) {
                const totalCurationWeight = calculateCurationWeightRshares(rewardPool, post.votePositiveRshareSum);
                const votePay = curatorPortion.multipliedBy(vote.curationWeight).dividedBy(totalCurationWeight).toFixed(token.precision, api.BigNumber.ROUND_DOWN);
                api.emit('curationReward', { rewardPoolId, authorperm, symbol, account: vote.voter, amount: votePay });
                await payUser(symbol, votePay, vote.voter);
            }
        }
        if (votesToPayout.length < 1000) {
            break;
        }
        offset += 1000;
        votesToPayout = await api.db.find('votes', { authorperm, symbol }, 1000, offset, [{ index: 'timestamp', descending: false }, { index: '_id', descending: false }]);
    }
}

async function payOutPost(rewardPool, token, post) {
    const postClaims = calculateWeightRshares(rewardPool, post.voteRshareSum);
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
    api.emit('authorReward', { rewardPoolId, authorperm, symbol, account: post.author, amount: authorPortion });
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
       postsToPayout.reduce((x,y) => y.plus(calculateWeightRshares(rewardPool, x.voteRshareSum)), api.BigNumber(0)))
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
