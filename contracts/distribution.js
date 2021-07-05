/* eslint-disable no-await-in-loop */
/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
/* global actions, api */

const DistStrategy = ['fixed', 'pool'];

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('batches');
  if (tableExists === false) {
    await api.db.createTable('batches');
    await api.db.createTable('params');

    const params = {};
    params.distCreationFee = '500';
    params.distUpdateFee = '250';
    params.distTickHours = '24';
    params.maxDistributionsPerBlock = 1;
    params.maxRecipientsPerBlock = 50;
    params.processQueryLimit = 1000;
    await api.db.insert('params', params);
  } else {
    const params = await api.db.findOne('params', {});
    if (!params.updateIndex) {
      await api.db.addIndexes('batches', [{ name: 'lastTickTime', index: { lastTickTime: 1 } }]);
      await api.db.createTable('pending', [
        'distId',
        { name: 'byDistSymbol', index: { distId: 1, symbol: 1 } },
        { name: 'byDistBalance', index: { distId: 1, account: 1, symbol: 1 } },
      ]);
      params.updateIndex = 1;
      await api.db.update('params', params);
    }
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    distCreationFee,
    distUpdateFee,
    distTickHours,
    maxDistributionsPerBlock,
    maxRecipientsPerBlock,
    processQueryLimit,
  } = payload;

  const params = await api.db.findOne('params', {});

  if (distCreationFee) {
    if (!api.assert(typeof distCreationFee === 'string' && !api.BigNumber(distCreationFee).isNaN() && api.BigNumber(distCreationFee).gte(0), 'invalid distCreationFee')) return;
    params.distCreationFee = distCreationFee;
  }
  if (distUpdateFee) {
    if (!api.assert(typeof distUpdateFee === 'string' && !api.BigNumber(distUpdateFee).isNaN() && api.BigNumber(distUpdateFee).gte(0), 'invalid distUpdateFee')) return;
    params.distUpdateFee = distUpdateFee;
  }
  if (distTickHours) {
    if (!api.assert(typeof distTickHours === 'string' && api.BigNumber(distTickHours).isInteger() && api.BigNumber(distTickHours).gte(1), 'invalid distTickHours')) return;
    params.distTickHours = distTickHours;
  }
  if (maxDistributionsPerBlock) {
    if (!api.assert(typeof maxDistributionsPerBlock === 'string' && api.BigNumber(maxDistributionsPerBlock).isInteger() && api.BigNumber(maxDistributionsPerBlock).gte(1), 'invalid maxDistributionsPerBlock')) return;
    params.maxDistributionsPerBlock = api.BigNumber(maxDistributionsPerBlock).toNumber();
  }
  if (maxRecipientsPerBlock) {
    if (!api.assert(typeof maxRecipientsPerBlock === 'string' && api.BigNumber(maxRecipientsPerBlock).isInteger() && api.BigNumber(maxRecipientsPerBlock).gte(1), 'invalid maxRecipientsPerBlock')) return;
    params.maxRecipientsPerBlock = api.BigNumber(maxRecipientsPerBlock).toNumber();
  }
  if (processQueryLimit) {
    if (!api.assert(typeof processQueryLimit === 'string' && api.BigNumber(processQueryLimit).isInteger() && api.BigNumber(processQueryLimit).gte(1), 'invalid processQueryLimit')) return;
    params.processQueryLimit = api.BigNumber(processQueryLimit).toNumber();
  }

  await api.db.update('params', params);
};

async function processBatch(batch, symbol, isFlush = false) {
  const balance = batch.tokenBalances.find(b => b.symbol === symbol);
  const balanceStart = balance.quantity;
  const payout = batch.tokenMinPayout.find(p => p.symbol === symbol);

  if (balance !== undefined && payout !== undefined
    && (api.BigNumber(balanceStart).gt(api.BigNumber(payout.quantity)) || isFlush === true)) {
    // pay out token balance to recipients by configured share percentage
    for (let i = 0; i < batch.tokenRecipients.length; i += 1) {
      const recipient = batch.tokenRecipients[i];
      const recipientShare = api.BigNumber(balanceStart).multipliedBy(recipient.pct).dividedBy(100).toFixed(3);
      const tx = await api.transferTokens(recipient.account, symbol, recipientShare, recipient.type);

      // keep the share leftover for the next run
      if (api.assert(tx.errors === undefined, `unable to send ${recipientShare} ${symbol} to ${recipient.account}`)) {
        // eslint-disable-next-line no-param-reassign
        balance.quantity = api.BigNumber(balance.quantity).minus(recipientShare);
      }
    }
    await api.db.update('batches', batch);
    return true;
  }
  return false;
}

async function validateMinPayout(tokenMinPayout) {
  if (!api.assert(tokenMinPayout && Array.isArray(tokenMinPayout), 'tokenMinPayout must be an array')) return false;
  if (!api.assert(tokenMinPayout.length >= 1, 'specify at least one minimum payout configuration')) return false;

  const tokenMinPayoutSymbols = new Set();
  for (let i = 0; i < tokenMinPayout.length; i += 1) {
    const tokenMinPayoutConfig = tokenMinPayout[i];
    if (!api.assert(tokenMinPayoutConfig && tokenMinPayoutConfig.symbol
      && typeof (tokenMinPayoutConfig.symbol) === 'string', 'tokenMinPayout invalid')) return false;

    if (!api.assert(!tokenMinPayoutSymbols.has(tokenMinPayoutConfig.symbol), 'tokenMinPayout cannot have duplicate symbols')) return false;
    tokenMinPayoutSymbols.add(tokenMinPayoutConfig.symbol);

    if (!api.assert(tokenMinPayoutConfig.quantity
      && api.BigNumber(tokenMinPayoutConfig.quantity).dp() <= 3 && api.BigNumber(tokenMinPayoutConfig.quantity).gte(0), 'invalid quantity')) return false;
  }
  return true;
}

async function validateRecipients(tokenRecipients) {
  const params = await api.db.findOne('params', {});
  if (!api.assert(tokenRecipients && Array.isArray(tokenRecipients), 'tokenRecipients must be an array')) return false;
  if (!api.assert(tokenRecipients.length >= 1 && tokenRecipients.length <= params.maxRecipientsPerBlock, `1-${params.maxRecipientsPerBlock} tokenRecipients are supported`)) return false;

  const tokenRecipientsAccounts = new Set();
  let tokenRecipientsTotalShare = 0;
  for (let i = 0; i < tokenRecipients.length; i += 1) {
    const tokenRecipientsConfig = tokenRecipients[i];
    if (!api.assert(tokenRecipientsConfig && tokenRecipientsConfig.account
      && typeof (tokenRecipientsConfig.account) === 'string', 'tokenRecipients invalid')
      && !api.assert(tokenRecipientsConfig.account.length >= 3 && tokenRecipientsConfig.account.length <= 16, 'invalid account')) return false;

    if (!api.assert(!tokenRecipientsAccounts.has(tokenRecipientsConfig.account), 'tokenRecipients cannot have duplicate accounts')) return false;
    tokenRecipientsAccounts.add(tokenRecipientsConfig.account);

    if (!api.assert(Number.isInteger(tokenRecipientsConfig.pct)
      && tokenRecipientsConfig.pct >= 1 && tokenRecipientsConfig.pct <= 100,
    'tokenRecipients pct must be an integer from 1 to 100')) return false;
    tokenRecipientsTotalShare += tokenRecipientsConfig.pct;

    if (!api.assert(['user', 'contract'].includes(tokenRecipientsConfig.type), 'tokenRecipients type must be user or contract')) return false;
  }
  if (!api.assert(tokenRecipientsTotalShare === 100, 'tokenRecipients pct must total 100')) return false;
  return true;
}

function validateIncomingToken(batch, symbol) {
  for (let i = 0; i < batch.tokenMinPayout.length; i += 1) {
    if (batch.tokenMinPayout[i].symbol === symbol) return true;
  }
  return false;
}

async function validatePool(tokenPair) {
  return await api.db.findOneInTable('marketpools', 'pools', { tokenPair }) !== null;
}

actions.create = async (payload) => {
  const {
    strategy, excludeAccount, tokenPair,
    tokenMinPayout, tokenRecipients,
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { distCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(distCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(distCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(typeof strategy === 'string' && DistStrategy.indexOf(strategy) !== -1, 'invalid strategy')) {
    const now = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const newDist = {
      strategy,
      active: false,
      creator: api.sender,
      lastTickTime: now.getTime(),
    };
    if (strategy === 'fixed' && await validateMinPayout(tokenMinPayout) && await validateRecipients(tokenRecipients)) {
      newDist.tokenMinPayout = tokenMinPayout;
      newDist.tokenRecipients = tokenRecipients;
    } else if (strategy === 'pool') {
      if (excludeAccount !== undefined && !api.assert(Array.isArray(excludeAccount), 'excludeAccount must be an array')) return;
      if (!api.assert(await validatePool(tokenPair), 'invalid tokenPair')) return;
      newDist.tokenPair = tokenPair;
      newDist.excludeAccount = excludeAccount || [];
    } else {
      return;
    }
    const createdDist = await api.db.insert('batches', newDist);

    // burn the token creation fees
    if (api.sender !== api.owner && api.BigNumber(distCreationFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: distCreationFee, isSignedWithActiveKey,
      });
    }
    api.emit('create', { id: createdDist._id });
  }
};

actions.flush = async (payload) => {
  const {
    id, symbol, isSignedWithActiveKey,
  } = payload;

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(api.sender === api.owner || api.sender === dist.creator, 'must be contract owner or creator')) {
    if (await processBatch(dist, symbol, true)) {
      api.emit('flush', { memo: `${symbol} payout distributed` });
    }
  }
};

actions.update = async (payload) => {
  const {
    id,
    excludeAccount, tokenPair,
    tokenMinPayout, tokenRecipients,
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { distUpdateFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(distUpdateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(distUpdateFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the update fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    const exDist = await api.db.findOne('batches', { _id: id });
    if (api.assert(exDist, 'distribution not found')) {
      if (exDist.strategy === 'fixed') {
        if (!await validateMinPayout(tokenMinPayout)
         || !await validateRecipients(tokenRecipients)) return;
        exDist.tokenMinPayout = tokenMinPayout;
        exDist.tokenRecipients = tokenRecipients;
      } else if (exDist.strategy === 'pool') {
        api.debug(typeof excludeAccount);
        if (excludeAccount !== undefined && api.assert(Array.isArray(excludeAccount), 'excludeAccount must be an array')) {
          exDist.excludeAccount = excludeAccount;
        }
        if (tokenPair !== undefined && api.assert(await validatePool(tokenPair), 'invalid tokenPair')) {
          exDist.tokenPair = tokenPair;
        }
      } else {
        return;
      }
      await api.db.update('batches', exDist);

      // burn the token creation fees
      if (api.sender !== api.owner && api.BigNumber(distUpdateFee).gt(0)) {
        await api.executeSmartContract('tokens', 'transfer', {
          // eslint-disable-next-line no-template-curly-in-string
          to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: distUpdateFee, isSignedWithActiveKey,
        });
      }
      api.emit('update', { id: exDist._id });
    }
  }
};

actions.setActive = async (payload) => {
  const {
    id,
    active,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) {
    return;
  }
  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found')
    && api.assert(dist.creator === api.sender || api.owner === api.sender, 'you must be the creator of this distribution')) {
    dist.active = !!active;
    await api.db.update('batches', dist);
  }
};

actions.deposit = async (payload) => {
  const {
    id, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    || !api.assert(quantity && api.BigNumber(quantity).dp() <= 3 && api.BigNumber(quantity).gt(0), 'invalid quantity')) {
    return;
  }

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to deposit')
    && api.assert(validateIncomingToken(dist, symbol), `${symbol} is not accepted by this distribution`)) {
    // deposit requested tokens to contract
    const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: 'distribution' });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'distribution' && el.data.quantity === quantity) !== undefined) {
      // update token balances
      if (dist.tokenBalances) {
        let hasBalance = false;
        for (let i = 0; i < dist.tokenBalances.length; i += 1) {
          if (dist.tokenBalances[i].symbol === symbol) {
            dist.tokenBalances[i].quantity += quantity;
            hasBalance = true;
            break;
          }
        }
        if (!hasBalance) {
          dist.tokenBalances.push({ symbol, quantity });
        }
      } else {
        dist.tokenBalances = [
          { symbol, quantity },
        ];
      }
      await api.db.update('batches', dist);
      // check if at minimum payout, and distribute
      const payNow = await processBatch(dist, symbol);
      if (payNow) {
        api.emit('deposit', { memo: `Deposit received. ${symbol} payout distributed` });
      } else {
        api.emit('deposit', { memo: `Deposit received. ${symbol} payout pending` });
      }
    }
  }
};

async function getPoolRecipients(dist, params) {
  let offset = 0;
  let result = [];
  let lastResult = [];
  const pool = await api.db.findOneInTable('marketpools', 'pools', { tokenPair: dist.tokenPair });
  if (!pool || pool.totalShares <= 0) return result;

  while ((lastResult !== null && lastResult.length === params.processQueryLimit) || offset === 0) {
    lastResult = await api.db.findInTable('marketpools', 'liquidityPositions', { tokenPair: dist.tokenPair },
      params.processQueryLimit,
      offset,
      [{ index: '_id', descending: false }]);
    // eslint-disable-next-line no-loop-func
    result = result.concat(lastResult.map((r) => {
      r.type = 'user';
      r.pct = api.BigNumber(lastResult.shares).dividedBy(pool.totalShares);
      return r;
    }));
    offset += params.processQueryLimit;
  }
  return result;
}

async function calculatePayouts(dist, params) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  if (!(Array.isArray(dist.tokenBalances) && dist.tokenBalances.length > 0)) return;
  const payTokens = dist.tokenBalances.filter(d => d.quantity > 0);
  if (payTokens.length === 0) return;

  let tokenRecipients = [];
  if (dist.strategy === 'pool') {
    tokenRecipients = await getPoolRecipients(dist, params);
  }

  let newPending = [];
  for (let i = 0; i < payTokens.length; i += 1) {
    const payToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: payTokens[i].symbol });
    for (let j = 0; j < tokenRecipients.length; j += 1) {
      const recipient = tokenRecipients[j];
      const recipientShare = api.BigNumber(payTokens[i].quantity).multipliedBy(recipient.pct).dividedBy(100).toFixed(payToken.precision, api.BigNumber.ROUND_DOWN);
    }
  }

  api.emit('miningLottery', { poolId: pool.id, winners });
  for (let i = 0; i < winners.length; i += 1) {
    const winner = winners[i];
    await api.executeSmartContract('tokens', 'issue',
      { to: winner.winner, symbol: minedToken.symbol, quantity: winningAmount });
  }
  // eslint-disable-next-line no-param-reassign
  pool.nextLotteryTimestamp = api.BigNumber(blockDate.getTime())
    .plus(pool.lotteryIntervalHours * 3600 * 1000).toNumber();
  await api.db.update('pools', pool);  
}

actions.checkPendingDistributions = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const params = await api.db.findOne('params', {});
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const tickTime = api.BigNumber(blockDate.getTime())
      .minus(params.distTickHours * 3600 * 1000)
      .toNumber();

    const pendingDists = await api.db.find('batches',
      {
        active: true,
        lastTickTime: {
          $lte: tickTime,
        },
      },
      params.maxDistributionsPerBlock,
      0,
      [{ index: 'lastTickTime', descending: false }, { index: '_id', descending: false }]);

    for (let i = 0; i < pendingDists.length; i += 1) {
      await calculatePayouts(pendingDists[i], params);
    }
  }
};
