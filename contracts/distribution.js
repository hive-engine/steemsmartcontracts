/* eslint-disable no-await-in-loop, max-len */
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
    await api.db.insert('params', params);
  } else {
    const params = await api.db.findOne('params', {});
    if (!params.updateIndex) {
      await api.db.addIndexes('batches', [{ name: 'lastTickTime', index: { lastTickTime: 1 } }]);
      await api.db.createTable('pendingPayments', ['dueTime']);
      params.distTickHours = '24';
      params.maxDistributionsLimit = 1;
      params.maxTransferLimit = 50;
      params.processQueryLimit = 1000;
      params.updateIndex = 1;
      await api.db.update('params', params);
    } else if (params.updateIndex === 1) {
      const clearPending = await api.db.find('pendingPayments', {});
      for (let i = 0; i < clearPending.length; i += 1) {
        await api.db.remove('pendingPayments', clearPending[i]);
      }
      const syncDists = await api.db.find('batches', {});
      for (let i = 0; i < syncDists.length; i += 1) {
        const dist = syncDists[i];
        if (dist.tokenBalances) {
          let update = false;
          const hiveIndex = dist.tokenBalances.findIndex(t => t.symbol === 'SWAP.HIVE');
          if (hiveIndex !== -1) {
            dist.tokenBalances[hiveIndex].quantity = api.BigNumber('0').toFixed(8);
            update = true;
          }
          const simIndex = dist.tokenBalances.findIndex(t => t.symbol === 'SIM');
          if (simIndex !== -1) {
            dist.tokenBalances[simIndex].quantity = api.BigNumber('0').toFixed(3);
            update = true;
          }
          if (update) await api.db.update('batches', dist);
        }
      }
      params.updateIndex = 2;
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
    maxDistributionsLimit,
    maxTransferLimit,
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
  if (maxDistributionsLimit) {
    if (!api.assert(typeof maxDistributionsLimit === 'string' && api.BigNumber(maxDistributionsLimit).isInteger() && api.BigNumber(maxDistributionsLimit).gte(1), 'invalid maxDistributionsLimit')) return;
    params.maxDistributionsLimit = api.BigNumber(maxDistributionsLimit).toNumber();
  }
  if (maxTransferLimit) {
    if (!api.assert(typeof maxTransferLimit === 'string' && api.BigNumber(maxTransferLimit).isInteger() && api.BigNumber(maxTransferLimit).gte(1), 'invalid maxTransferLimit')) return;
    params.maxTransferLimit = api.BigNumber(maxTransferLimit).toNumber();
  }
  if (processQueryLimit) {
    if (!api.assert(typeof processQueryLimit === 'string' && api.BigNumber(processQueryLimit).isInteger() && api.BigNumber(processQueryLimit).gte(1), 'invalid processQueryLimit')) return;
    params.processQueryLimit = api.BigNumber(processQueryLimit).toNumber();
  }

  await api.db.update('params', params);
};

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

async function validateRecipients(params, tokenRecipients) {
  if (!api.assert(tokenRecipients && Array.isArray(tokenRecipients), 'tokenRecipients must be an array')) return false;
  if (!api.assert(tokenRecipients.length >= 1 && tokenRecipients.length <= params.maxTransferLimit, `1-${params.maxTransferLimit} tokenRecipients are supported`)) return false;

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
    if (tokenRecipientsConfig.type === 'contract'
      && !api.assert(typeof tokenRecipientsConfig.contractPayload === 'object', 'contract recipients must have contractPayload')) return false;
  }
  if (!api.assert(tokenRecipientsTotalShare === 100, 'tokenRecipients pct must total 100')) return false;
  return true;
}

function validateIncomingToken(dist, symbol) {
  for (let i = 0; i < dist.tokenMinPayout.length; i += 1) {
    if (dist.tokenMinPayout[i].symbol === symbol) return true;
  }
  return false;
}

function validateBonusCurve(obj) {
  if (!api.assert(typeof obj === 'object' && obj.constructor.name === 'Object', 'invalid bonusCurve settings')) return false;
  if ('periodBonusPct' in obj || 'numPeriods' in obj) {
    if (!api.assert(typeof obj.periodBonusPct === 'string'
      && api.BigNumber(obj.periodBonusPct).isInteger()
      && api.BigNumber(obj.periodBonusPct).gt(0) && api.BigNumber(obj.periodBonusPct).lt(100)
      && typeof obj.numPeriods === 'string'
      && api.BigNumber(obj.numPeriods).isInteger()
      && api.BigNumber(obj.numPeriods).gt(0) && api.BigNumber(obj.numPeriods).lt(5555), 'invalid bonusCurve settings')) return false;
  } else if (!api.assert(Object.keys(obj).length === 0, 'invalid bonusCurve settings')) return false;
  return true;
}

async function validatePool(tokenPair) {
  return await api.db.findOneInTable('marketpools', 'pools', { tokenPair }) !== null;
}

actions.create = async (payload) => {
  const {
    strategy, numTicks,
    excludeAccount, tokenPair, bonusCurve,
    tokenMinPayout, tokenRecipients,
    isSignedWithActiveKey,
  } = payload;

  const params = await api.db.findOne('params', {});
  const { distCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(distCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(distCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(typeof strategy === 'string' && DistStrategy.indexOf(strategy) !== -1, 'invalid strategy')
    && api.assert(typeof numTicks === 'string'
      && api.BigNumber(numTicks).isInteger()
      && api.BigNumber(numTicks).gt(0)
      && api.BigNumber(numTicks).lte(5555), 'numTicks must be a number between 1 and 5555')) {
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const newDist = {
      strategy,
      numTicks,
      numTicksLeft: api.BigNumber(numTicks).toNumber(),
      active: false,
      creator: api.sender,
      lastTickTime: blockDate.getTime(),
    };
    if (strategy === 'fixed' && await validateMinPayout(tokenMinPayout) && await validateRecipients(params, tokenRecipients)) {
      newDist.tokenMinPayout = tokenMinPayout;
      newDist.tokenRecipients = tokenRecipients;
    } else if (strategy === 'pool') {
      if (!api.assert(await validatePool(tokenPair), 'invalid tokenPair')) return;
      if (excludeAccount !== undefined && !api.assert(Array.isArray(excludeAccount), 'excludeAccount must be an array')) return;
      if (bonusCurve !== undefined && !validateBonusCurve(bonusCurve)) return;
      newDist.tokenPair = tokenPair;
      newDist.excludeAccount = excludeAccount || [];
      newDist.bonusCurve = bonusCurve || {};
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

actions.update = async (payload) => {
  const {
    id, numTicks,
    excludeAccount, tokenPair, bonusCurve,
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
    if (api.assert(exDist, 'distribution not found')
      && api.assert(api.sender === api.owner || api.sender === exDist.creator, 'must be owner or creator')) {
      if (numTicks && api.assert(typeof numTicks === 'string'
        && api.BigNumber(numTicks).isInteger()
        && api.BigNumber(numTicks).gt(0)
        && api.BigNumber(numTicks).lte(5555), 'numTicks must be a number between 1 and 5555')) {
        exDist.numTicks = numTicks;
        exDist.numTicksLeft = api.BigNumber(numTicks).toNumber();
      }
      if (exDist.strategy === 'fixed') {
        if (!await validateMinPayout(tokenMinPayout)
         || !await validateRecipients(params, tokenRecipients)) return;
        exDist.tokenMinPayout = tokenMinPayout;
        exDist.tokenRecipients = tokenRecipients;
      } else if (exDist.strategy === 'pool') {
        if (excludeAccount !== undefined && api.assert(Array.isArray(excludeAccount), 'excludeAccount must be an array')) {
          exDist.excludeAccount = excludeAccount;
        }
        if (tokenPair !== undefined && api.assert(await validatePool(tokenPair), 'invalid tokenPair')) {
          exDist.tokenPair = tokenPair;
        }
        if (bonusCurve !== undefined && validateBonusCurve(bonusCurve)) {
          exDist.bonusCurve = bonusCurve;
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
    api.emit('setActive', { id: dist._id, active: dist.active });
  }
};

async function updateTokenBalances(dist, token, quantity) {
  const upDist = dist;
  if (upDist.tokenBalances) {
    const tIndex = upDist.tokenBalances.findIndex(t => t.symbol === token.symbol);
    if (tIndex === -1) {
      upDist.tokenBalances.push({ symbol: token.symbol, quantity });
    } else {
      upDist.tokenBalances[tIndex].quantity = api.BigNumber(upDist.tokenBalances[tIndex].quantity)
        .plus(quantity)
        .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
    }
  } else {
    upDist.tokenBalances = [
      { symbol: token.symbol, quantity },
    ];
  }
  await api.db.update('batches', upDist);
}

actions.deposit = async (payload) => {
  const {
    id, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  const depToken = await api.db.findOneInTable('tokens', 'tokens', { symbol });
  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    || !api.assert(typeof quantity === 'string' && api.BigNumber(quantity).gt(0), 'invalid quantity')
    || !api.assert(api.BigNumber(quantity).dp() <= depToken.precision, 'quantity precision mismatch')) {
    return;
  }

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to deposit')) {
    if (dist.strategy === 'fixed' && !api.assert(validateIncomingToken(dist, symbol), `${symbol} is not accepted by this distribution`)) return;

    // deposit requested tokens to contract
    const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: 'distribution' });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'distribution' && el.data.quantity === quantity) !== undefined) {
      await updateTokenBalances(dist, depToken, quantity);
      api.emit('deposit', { distId: id, symbol, quantity });
    }
  }
};

actions.receiveDtfTokens = async (payload) => {
  const {
    data, symbol, quantity,
    callingContractInfo,
  } = payload;

  if (!api.assert(callingContractInfo && callingContractInfo.name === 'tokenfunds', 'not authorized')) return;
  if (!api.assert(typeof data === 'object'
    && data.constructor.name === 'Object'
    && 'distId' in data
    && typeof data.distId === 'string'
    && api.BigNumber(data.distId).isInteger(), 'invalid DTF payload')) return;

  const dist = await api.db.findOne('batches', { _id: api.BigNumber(data.distId).toNumber() });
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to deposit')) {
    if (dist.strategy === 'fixed' && !api.assert(validateIncomingToken(dist, symbol), `${symbol} is not accepted by this distribution`)) return;
    const depToken = await api.db.findOneInTable('tokens', 'tokens', { symbol });
    await updateTokenBalances(dist, depToken, quantity);
    api.emit('receiveDtfTokens', { distId: data.distId, symbol, quantity });
  }
};

async function getEffectiveShares(params, dist, lp) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timeDiff = api.BigNumber(blockDate.getTime()).minus(lp.timeFactor);
  if (timeDiff.lte(params.distTickHours * 3600 * 1000)) return lp.shares;

  let multiplier = api.BigNumber('1');
  if (typeof dist.bonusCurve.numPeriods === 'string') {
    if (timeDiff.lt(params.distTickHours * dist.bonusCurve.numPeriods * 3600 * 1000)) {
      multiplier = api.BigNumber(dist.bonusCurve.periodBonusPct)
        .dividedBy('100')
        .times(timeDiff.dividedBy(params.distTickHours * 3600 * 1000).dp(0, api.BigNumber.ROUND_DOWN))
        .plus(multiplier);
    } else {
      multiplier = api.BigNumber(dist.bonusCurve.periodBonusPct)
        .dividedBy('100')
        .times(dist.bonusCurve.numPeriods)
        .plus(multiplier);
    }
  }
  return api.BigNumber(lp.shares).times(multiplier);
}

async function getPoolRecipients(params, dist) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const minHoldTime = api.BigNumber(blockDate.getTime()).minus(params.distTickHours * 3600 * 1000).toNumber();
  const result = [];
  let offset = 0;
  let processQuery = [];
  const pool = await api.db.findOneInTable('marketpools', 'pools', { tokenPair: dist.tokenPair });
  if (!pool || pool.totalShares <= 0) return result;

  while ((processQuery !== null
      && processQuery.length === params.processQueryLimit)
      || offset === 0) {
    processQuery = await api.db.findInTable('marketpools', 'liquidityPositions',
      {
        tokenPair: dist.tokenPair,
        account: { $nin: dist.excludeAccount },
        timeFactor: { $lte: minHoldTime },
      },
      params.processQueryLimit,
      offset,
      [{ index: '_id', descending: false }]);
    for (let i = 0; i < processQuery.length; i += 1) {
      const lp = processQuery[i];
      lp.effShares = await getEffectiveShares(params, dist, lp);
      result.push(lp);
    }
    offset += params.processQueryLimit;
  }
  return result;
}

async function payRecipient(account, symbol, quantity, type = 'user', contractPayload = null) {
  if (api.BigNumber(quantity).gt(0)) {
    const res = await api.transferTokens(account, symbol, quantity, type);
    if (type === 'contract' && contractPayload) {
      await api.executeSmartContract(account, 'receiveDistTokens',
        { data: contractPayload, symbol, quantity });
    }
    if (res.errors) {
      api.debug(`Error paying out distribution of ${quantity} ${symbol} to ${account} (TXID ${api.transactionId}): \n${res.errors}`);
      return false;
    }
    return true;
  }
  return false;
}

async function runDistribution(dist, params, flush = false) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const upDist = JSON.parse(JSON.stringify(dist));
  const payTokens = dist.tokenBalances.filter(d => api.BigNumber(d.quantity).gt(0));
  if (payTokens.length > 0) {
    if (dist.strategy === 'fixed') {
      const { tokenRecipients } = dist;
      while (tokenRecipients.length > 0) {
        const tr = tokenRecipients.shift();
        for (let i = 0; i < payTokens.length; i += 1) {
          const payToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: payTokens[i].symbol });
          const minPayout = dist.tokenMinPayout.find(p => p.symbol === payTokens[i].symbol);
          if (api.BigNumber(payTokens[i].quantity).gt(minPayout.quantity) || flush) {
            const payoutShare = api.BigNumber(payTokens[i].quantity)
              .multipliedBy(tr.pct)
              .dividedBy(100)
              .dividedBy(dist.numTicksLeft)
              .toFixed(payToken.precision, api.BigNumber.ROUND_DOWN);
            if (api.BigNumber(payoutShare).gt(0)) {
              if (await payRecipient(
                tr.account,
                payTokens[i].symbol,
                payoutShare,
                tr.type,
                tr.contractPayload || null,
              )) {
                const tbIndex = upDist.tokenBalances.findIndex(b => b.symbol === payTokens[i].symbol);
                upDist.tokenBalances[tbIndex].quantity = api.BigNumber(upDist.tokenBalances[tbIndex].quantity)
                  .minus(payoutShare)
                  .toFixed(payToken.precision, api.BigNumber.ROUND_DOWN);
                api.emit('payment', {
                  distId: dist._id, tokenPair: dist.tokenPair, symbol: payTokens[i].symbol, account: tr.account, quantity: payoutShare,
                });
              }
            }
          }
        }
      }
    } else if (dist.strategy === 'pool') {
      const tokenRecipients = await getPoolRecipients(params, dist);
      const shareTotal = tokenRecipients.reduce((acc, cur) => acc.plus(cur.effShares), api.BigNumber(0));
      if (api.assert(shareTotal.gt(0), 'no liquidity shares for this tokenPair')) {
        let payTxCount = 0;
        const storePending = [];
        while (tokenRecipients.length > 0) {
          const tr = tokenRecipients.shift();
          const payoutShare = api.BigNumber(tr.effShares).dividedBy(shareTotal);
          for (let i = 0; i < payTokens.length; i += 1) {
            const payToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: payTokens[i].symbol });
            const payoutQty = api.BigNumber(payTokens[i].quantity)
              .multipliedBy(payoutShare)
              .dividedBy(dist.numTicksLeft)
              .toFixed(payToken.precision, api.BigNumber.ROUND_DOWN);
            if (api.BigNumber(payoutQty).gt(0)) {
              let payResult = true;
              let payNow = true;
              if (payTxCount < params.maxTransferLimit) {
                payResult = await payRecipient(tr.account, payTokens[i].symbol, payoutQty);
              } else {
                payNow = false;
                storePending.push({
                  distId: dist._id,
                  account: tr.account,
                  symbol: payTokens[i].symbol,
                  quantity: payoutQty,
                });
              }
              if (payResult) {
                const tbIndex = upDist.tokenBalances.findIndex(b => b.symbol === payTokens[i].symbol);
                upDist.tokenBalances[tbIndex].quantity = api.BigNumber(upDist.tokenBalances[tbIndex].quantity)
                  .minus(payoutQty)
                  .toFixed(payToken.precision, api.BigNumber.ROUND_DOWN);
                if (payNow) {
                  api.emit('payment', {
                    distId: dist._id, tokenPair: dist.tokenPair, symbol: payTokens[i].symbol, account: tr.account, quantity: payoutQty,
                  });
                }
              }
              payTxCount += 1;
            }
          }
        }
        if (storePending.length > 0) await api.db.insert('pendingPayments', { dueTime: blockDate.getTime(), accounts: storePending });
      }
    }
  }

  upDist.numTicksLeft -= 1;
  upDist.lastTickTime = blockDate.getTime();
  await api.db.update('batches', upDist);
}

actions.flush = async (payload) => {
  const {
    id, isSignedWithActiveKey,
  } = payload;

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(api.sender === api.owner || api.sender === dist.creator, 'must be owner or creator')) {
    const params = await api.db.findOne('params', {});
    dist.numTicksLeft = 1;
    await api.db.update('batches', dist);
    await runDistribution(dist, params, true);
    api.emit('flush', { distId: dist._id });
  }
};

async function runPendingPay(pendingPay, params) {
  const payLimit = Math.min(params.maxTransferLimit, pendingPay.accounts.length);
  for (let i = payLimit - 1; i >= 0; i -= 1) {
    const p = pendingPay.accounts[i];
    if (await payRecipient(p.account, p.symbol, p.quantity)) {
      pendingPay.accounts.splice(i, 1);
      api.emit('payment', { ...p, pending: true });
    }
  }
  if (pendingPay.accounts.length === 0) {
    api.db.remove('pendingPayments', pendingPay);
  } else {
    api.db.update('pendingPayments', pendingPay);
  }
}

actions.checkPendingDistributions = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const params = await api.db.findOne('params', {});
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const tickTime = api.BigNumber(blockDate.getTime()).minus(params.distTickHours * 3600 * 1000).toNumber();

    const pendingDists = await api.db.find('batches',
      {
        active: true,
        numTicksLeft: { $gt: 0 },
        'tokenBalances.0': { $exists: true },
        lastTickTime: {
          $lte: tickTime,
        },
      },
      params.maxDistributionsLimit,
      0,
      [{ index: 'lastTickTime', descending: false }, { index: '_id', descending: false }]);

    // process distributions or pending payments
    if (pendingDists.length > 0) {
      for (let i = 0; i < pendingDists.length; i += 1) {
        await runDistribution(pendingDists[i], params);
      }
    } else {
      const pendingPay = await api.db.find('pendingPayments',
        {
          dueTime: {
            $lt: blockDate.getTime(),
          },
        },
        params.maxDistributionsLimit,
        0,
        [{ index: 'dueTime', descending: false }, { index: '_id', descending: false }]);

      if (pendingPay.length > 0) {
        for (let i = 0; i < pendingPay.length; i += 1) {
          await runPendingPay(pendingPay[i], params);
        }
      }
    }
  }
};
