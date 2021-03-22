/* eslint-disable no-await-in-loop */
/* eslint-disable no-underscore-dangle */
/* eslint-disable max-len */
/* global actions, api */

const FeeMethod = ['burn', 'issuer'];
const PayoutType = ['user', 'contract'];

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('funds');
  if (tableExists === false) {
    await api.db.createTable('funds', ['id', 'lastTickTime']);
    await api.db.createTable('proposals', ['fundId', 'approvalWeight']);
    await api.db.createTable('approvals', ['from', 'to']);
    await api.db.createTable('accounts', ['account']);
    await api.db.createTable('params');

    const params = {
      dtfCreationFee: '1000',
      dtfUpdateFee: '300',
      dtfTickHours: '24',
      maxDtfsPerBlock: 40,
      processQueryLimit: 1000,
    };
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  const { dtfCreationFee, dtfTickHours } = payload;
  if (api.sender !== api.owner) return;
  const params = await api.db.findOne('params', {});
  if (dtfCreationFee) {
    if (!api.assert(typeof dtfCreationFee === 'string' && !api.BigNumber(dtfCreationFee).isNaN() && api.BigNumber(dtfCreationFee).gte(0), 'invalid dtfCreationFee')) return;
    params.dtfCreationFee = dtfCreationFee;
  }
  if (dtfTickHours) {
    if (!api.assert(typeof dtfTickHours === 'string' && api.BigNumber(dtfTickHours).isInteger() && api.BigNumber(dtfTickHours).gte(1), 'invalid dtfTickHours')) return;
    params.dtfTickHours = dtfTickHours;
  }
  await api.db.update('params', params);
};

function generateDtfId(dtf) {
  return `${dtf.payToken.replace('.', '-')}:${dtf.voteToken.replace('.', '-')}`;
}

async function updateProposalWeight(id, deltaApprovalWeight) {
  const proposal = await api.db.findOne('proposals', { _id: id });
  if (proposal) {
    proposal.approvalWeight = api.BigNumber(proposal.approvalWeight).plus(deltaApprovalWeight).toNumber();
    await api.db.update('proposals', proposal);
  }
}

async function validateTokens(payTokenObj, voteTokenObj) {
  if (!api.assert(payTokenObj && (payTokenObj.issuer === api.sender
    // eslint-disable-next-line no-template-curly-in-string
    || (payTokenObj.symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" && api.sender === api.owner)), 'must be issuer of payToken')) return false;
  if (!api.assert(voteTokenObj && voteTokenObj.stakingEnabled, 'voteToken must have staking enabled')) return false;
  return true;
}

function validateDateTime(str) {
  // RegExp /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/
  if (str.length === 24) {
    for (let i = 0; i < str.length; i += 1) {
      if ([5, 8, 11, 14, 17, 21].indexOf(i) !== 1) break;
      const code = str.charCodeAt(i);
      if (!(code > 47 && code < 58)) return false;
    }
    return true;
  }
  return false;
}

function validateDateRange(startDate, endDate, maxDays) {
  if (!api.assert(validateDateTime(startDate) && validateDateTime(endDate), 'invalid datetime format: YYYY-MM-DDThh:mm:ss.sssZ')) return false;
  const now = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (!api.assert(api.BigNumber(start.getTime()).lt(api.BigNumber(end.getTime()).minus(86400 * 1000)), 'dates must be at least 1 day apart')
    || !api.assert(api.BigNumber(start.getTime()).gt(api.BigNumber(now.getTime()).plus(86400 * 1000)), 'startDate must be at least 1 day in the future')) return false;
  const range = api.BigNumber(start.getTime()).minus(end.getTime()).abs();
  const rangeDays = range.dividedBy(1000 * 60 * 60 * 24).toFixed(0, api.BigNumber.ROUND_CEIL);
  if (!api.assert(api.BigNumber(rangeDays).lte(maxDays), 'date range exceeds DTF maxDays')) return false;
  return true;
}

function validateDateChange(date, newDate) {
  const cur = new Date(date);
  const repl = new Date(newDate);
  if (!api.assert(repl <= cur, 'date can only be reduced')) return false;
  return true;
}

actions.createFund = async (payload) => {
  const {
    payToken, voteToken, voteThreshold, maxDays, maxAmountPerDay, proposalFee, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { dtfCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(dtfCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(dtfCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(typeof voteThreshold === 'string' && api.BigNumber(voteThreshold).gt(0), 'invalid voteThreshold: greater than 0')
    && api.assert(typeof maxDays === 'string' && api.BigNumber(maxDays).isInteger() && api.BigNumber(maxDays).gt(0) && api.BigNumber(maxDays).lte(730), 'invalid maxDays: integer between 1 and 730')
    && api.assert(typeof maxAmountPerDay === 'string' && api.BigNumber(maxAmountPerDay).gt(0), 'invalid maxAmountPerDay: greater than 0')) {
    if (proposalFee) {
      if (!api.assert(typeof proposalFee === 'object'
        && typeof proposalFee.method === 'string' && FeeMethod.indexOf(proposalFee.method) !== -1
        && typeof proposalFee.symbol === 'string'
        && typeof proposalFee.amount === 'string' && api.BigNumber(proposalFee.amount).gt(0), 'invalid proposalFee')) return;
      const feeTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: proposalFee.symbol });
      if (!api.assert(feeTokenObj && api.BigNumber(proposalFee.amount).dp() <= feeTokenObj.precision, 'invalid proposalFee token or precision')) return;
    }
    const payTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: payToken });
    const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: voteToken });
    if (!await validateTokens(payTokenObj, voteTokenObj)
      || !api.assert(api.BigNumber(maxAmountPerDay).dp() <= payTokenObj.precision, 'maxAmountPerDay precision mismatch')
      || !api.assert(api.BigNumber(voteThreshold).dp() <= voteTokenObj.precision, 'voteThreshold precision mismatch')) return;
    const now = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const newDtf = {
      payToken,
      voteToken,
      voteThreshold,
      maxDays,
      maxAmountPerDay,
      proposalFee,
      active: false,
      creator: api.sender,
      lastTickTime: now.getTime(),
    };
    newDtf.id = generateDtfId(newDtf);
    const existingDtf = await api.db.findOne('funds', { id: newDtf.id });
    if (!api.assert(!existingDtf, 'DTF already exists')) return;

    const insertedDtf = await api.db.insert('funds', newDtf);

    // burn the token creation fees
    if (api.sender !== api.owner && api.BigNumber(dtfCreationFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: dtfCreationFee, isSignedWithActiveKey,
      });
    }
    api.emit('createFund', { id: insertedDtf.id });
  }
};

actions.updateFund = async (payload) => {
  const {
    fundId, voteThreshold, maxDays, maxAmountPerDay, proposalFee, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { dtfUpdateFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(dtfUpdateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(dtfUpdateFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(typeof voteThreshold === 'string' && api.BigNumber(voteThreshold).gt(0), 'invalid voteThreshold: greater than 0')
    && api.assert(typeof maxDays === 'string' && api.BigNumber(maxDays).isInteger() && api.BigNumber(maxDays).gt(0) && api.BigNumber(maxDays).lte(730), 'invalid maxDays: integer between 1 and 730')
    && api.assert(typeof maxAmountPerDay === 'string' && api.BigNumber(maxAmountPerDay).gt(0), 'invalid maxAmountPerDay: greater than 0')) {
    if (proposalFee) {
      if (!api.assert(typeof proposalFee === 'object'
        && typeof proposalFee.method === 'string' && FeeMethod.indexOf(proposalFee.method) !== -1
        && typeof proposalFee.symbol === 'string'
        && typeof proposalFee.amount === 'string' && api.BigNumber(proposalFee.amount).gt(0), 'invalid proposalFee')) return;
      const feeTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: proposalFee.symbol });
      if (!api.assert(feeTokenObj && api.BigNumber(proposalFee.amount).dp() <= feeTokenObj.precision, 'invalid proposalFee token or precision')) return;
    }
    const existingDtf = await api.db.findOne('funds', { id: fundId });
    if (!api.assert(existingDtf, 'DTF not found')
      || !api.assert(existingDtf.creator === api.sender || api.owner === api.sender, 'must be DTF creator')) return;
    const payTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: existingDtf.payToken });
    const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: existingDtf.voteToken });
    if (!api.assert(api.BigNumber(maxAmountPerDay).dp() <= payTokenObj.precision, 'maxAmountPerDay precision mismatch')
      || !api.assert(api.BigNumber(voteThreshold).dp() <= voteTokenObj.precision, 'voteThreshold precision mismatch')) return;
    const newDtf = {
      voteThreshold,
      maxDays,
      maxAmountPerDay,
      proposalFee,
      active: false,
    };
    await api.db.update('funds', newDtf);

    // burn the token creation fees
    if (api.sender !== api.owner && api.BigNumber(dtfUpdateFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: dtfUpdateFee, isSignedWithActiveKey,
      });
    }
    api.emit('updateFund', { id: fundId });
  }
};

actions.setDtfActive = async (payload) => {
  const {
    fundId,
    active,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    return;
  }
  const dtf = await api.db.findOne('funds', { id: fundId });
  if (api.assert(dtf, 'DTF does not exist')
    && api.assert(dtf.creator === api.sender || api.owner === api.sender, 'must be DTF creator')) {
    dtf.active = !!active;
    await api.db.update('funds', dtf);
    api.emit('setDtfActive', { id: dtf.id, active: dtf.active });
  }
};

actions.createProposal = async (payload) => {
  const {
    fundId, title, startDate, endDate, amountPerDay,
    authorperm, payout, isSignedWithActiveKey,
  } = payload;

  const dtf = await api.db.findOne('funds', { id: fundId });
  if (!api.assert(dtf, 'DTF does not exist')) return;

  let authorizedCreation = true;
  if (dtf.proposalFee) {
    const feeTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: dtf.proposalFee.symbol });
    authorizedCreation = api.BigNumber(dtf.proposalFee.amount).lte(0) || api.sender === api.owner
      ? true
      : feeTokenBalance && api.BigNumber(feeTokenBalance.balance).gte(dtf.proposalFee.amount);
  }

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(dtf.active === true, 'DTF is not active')
    && api.assert(typeof title === 'string' && title.length > 0 && title.length <= 80, 'invalid title: between 1 and 80 characters')
    && api.assert(typeof authorperm === 'string' && authorperm.length > 0 && authorperm.length <= 255, 'invalid authorperm: between 1 and 255 characters')
    && api.assert(typeof amountPerDay === 'string'
      && api.BigNumber(amountPerDay).isInteger()
      && api.BigNumber(amountPerDay).gt(0), 'invalid amountPerDay: greater than 0')
    && api.assert(api.BigNumber(amountPerDay).lte(dtf.maxAmountPerDay), 'invalid amountPerDay: exceeds DTF maxAmountPerDay')
    && api.assert(typeof payout === 'object'
      && typeof payout.type === 'string' && PayoutType.indexOf(payout.type) !== -1
      && (payout.type !== 'contract' || typeof payout.contractPayload === 'object')
      && typeof payout.name === 'string' && payout.name.length >= 3 && payout.name.length <= 50, 'invalid payout settings')
    && validateDateRange(startDate, endDate, dtf.maxDays)) {
    const newProposal = {
      fundId,
      title,
      startDate,
      endDate,
      amountPerDay,
      authorperm,
      payout,
      creator: api.sender,
      approvalWeight: 0,
      active: true,
    };
    const insertedProposal = await api.db.insert('proposals', newProposal);

    if (api.sender !== api.owner && dtf.proposalFee) {
      if (dtf.proposalFee.method === 'burn') {
        await api.executeSmartContract('tokens', 'transfer', {
          to: 'null', symbol: dtf.proposalFee.symbol, quantity: dtf.proposalFee.amount,
        });
      } else if (dtf.proposalFee.method === 'issuer') {
        const feeTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: dtf.proposalFee.symbol });
        await api.executeSmartContract('tokens', 'transfer', {
          to: feeTokenObj.issuer, symbol: dtf.proposalFee.symbol, quantity: dtf.proposalFee.amount,
        });
      }
    }
    api.emit('createProposal', { id: insertedProposal._id });
  }
};

actions.updateProposal = async (payload) => {
  const {
    id, title, endDate, amountPerDay,
    authorperm, isSignedWithActiveKey,
  } = payload;

  if (!api.assert(typeof id === 'string' && api.BigNumber(id).isInteger(), 'invalid id')) return;
  const proposal = await api.db.findOne('proposals', { _id: api.BigNumber(id).toNumber() });
  if (!api.assert(proposal, 'proposal does not exist')
    || !api.assert(proposal.creator === api.sender || api.owner === api.sender, 'must be proposal creator')) return;
  const dtf = await api.db.findOne('funds', { id: proposal.fundId, active: true });
  if (!api.assert(dtf, 'DTF does not exist or inactive')) return;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(dtf.active === true, 'DTF is not active')
    && api.assert(typeof title === 'string' && title.length > 0 && title.length <= 80, 'invalid title: between 1 and 80 characters')
    && api.assert(typeof authorperm === 'string' && authorperm.length > 0 && authorperm.length <= 255, 'invalid authorperm: between 1 and 255 characters')
    && api.assert(typeof amountPerDay === 'string'
      && api.BigNumber(amountPerDay).isInteger()
      && api.BigNumber(amountPerDay).gt(0)
      && api.BigNumber(amountPerDay).lte(proposal.amountPerDay), 'invalid amountPerDay: greater than 0 and cannot be increased')
    && api.assert(api.BigNumber(amountPerDay).lte(dtf.maxAmountPerDay), 'invalid amountPerDay: exceeds DTF maxAmountPerDay')
    && validateDateChange(proposal.endDate, endDate)
    && validateDateRange(proposal.startDate, endDate, dtf.maxDays)) {
    proposal.title = title;
    proposal.endDate = endDate;
    proposal.amountPerDay = amountPerDay;
    proposal.authorperm = authorperm;
    await api.db.update('proposals', proposal);
    api.emit('updateProposal', { id: proposal._id });
  }
};

actions.disableProposal = async (payload) => {
  const {
    id, isSignedWithActiveKey,
  } = payload;

  if (!api.assert(typeof id === 'string' && api.BigNumber(id).isInteger(), 'invalid id')) return;
  const proposal = await api.db.findOne('proposals', { _id: api.BigNumber(id).toNumber() });
  if (!api.assert(proposal, 'proposal does not exist')
    || !api.assert(proposal.active === true, 'proposal already disabled')
    || !api.assert(proposal.creator === api.sender || api.owner === api.sender, 'must be proposal creator'
    || !api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key'))) return;

  proposal.active = false;
  await api.db.update('proposals', proposal);
  api.emit('disableProposal', { id: proposal._id });
};

actions.approveProposal = async (payload) => {
  const { id } = payload;

  if (api.assert(typeof id === 'string' && api.BigNumber(id).isInteger(), 'invalid id')) {
    const proposal = await api.db.findOne('proposals', { _id: api.BigNumber(id).toNumber() });

    if (api.assert(proposal, 'proposal does not exist')) {
      const dtf = await api.db.findOne('funds', { id: proposal.fundId });
      const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: dtf.voteToken });
      let acct = await api.db.findOne('accounts', { account: api.sender });
      if (acct === null) {
        acct = {
          account: api.sender,
          weights: [],
        };
        acct = await api.db.insert('accounts', acct);
      }

      let approval = await api.db.findOne('approvals', { from: api.sender, to: proposal._id });
      if (api.assert(approval === null, 'you already approved this proposal')) {
        approval = {
          from: api.sender,
          to: proposal._id,
        };
        await api.db.insert('approvals', approval);

        const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: dtf.voteToken });
        let approvalWeight = 0;
        if (balance && balance.stake) {
          approvalWeight = balance.stake;
        }
        if (balance && balance.delegationsIn) {
          approvalWeight = api.BigNumber(approvalWeight)
            .plus(balance.delegationsIn)
            .toFixed(voteTokenObj.precision, api.BigNumber.ROUND_HALF_UP);
        }
        const wIndex = acct.weights.findIndex(x => x.symbol === dtf.voteToken);
        if (wIndex !== -1) {
          acct.weights[wIndex].weight = approvalWeight;
        } else {
          acct.weights.push({ symbol: dtf.voteToken, weight: approvalWeight });
        }
        await api.db.update('accounts', acct);
        await updateProposalWeight(proposal._id, approvalWeight);
        api.emit('approveProposal', { id: proposal._id });
      }
    }
  }
};

actions.disapproveProposal = async (payload) => {
  const { id } = payload;

  if (api.assert(typeof id === 'string' && api.BigNumber(id).isInteger(), 'invalid id')) {
    const proposal = await api.db.findOne('proposals', { _id: api.BigNumber(id).toNumber() });
    if (api.assert(proposal, 'proposal does not exist')) {
      const dtf = await api.db.findOne('funds', { id: proposal.fundId });
      const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: dtf.voteToken });
      let acct = await api.db.findOne('accounts', { account: api.sender });
      if (acct === null) {
        acct = {
          account: api.sender,
          weights: [],
        };
        acct = await api.db.insert('accounts', acct);
      }

      const approval = await api.db.findOne('approvals', { from: api.sender, to: proposal._id });
      if (api.assert(approval !== null, 'you have not approved this proposal')) {
        await api.db.remove('approvals', approval);

        const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: dtf.voteToken });
        let approvalWeight = 0;
        if (balance && balance.stake) {
          approvalWeight = balance.stake;
        }
        if (balance && balance.delegationsIn) {
          approvalWeight = api.BigNumber(approvalWeight)
            .plus(balance.delegationsIn)
            .toFixed(voteTokenObj.precision, api.BigNumber.ROUND_HALF_UP);
        }
        const wIndex = acct.weights.findIndex(x => x.symbol === dtf.voteToken);
        const deltaApprovalWeight = api.BigNumber(approvalWeight).negated().toFixed(voteTokenObj.precision, api.BigNumber.ROUND_HALF_UP);
        if (wIndex !== -1) {
          acct.weights[wIndex].weight = deltaApprovalWeight;
        } else {
          acct.weights.push({ symbol: dtf.voteToken, weight: deltaApprovalWeight });
        }
        await api.db.update('accounts', acct);
        await updateProposalWeight(proposal._id, api.BigNumber(approvalWeight).negated());
        api.emit('disapproveProposal', { id: proposal._id });
      }
    }
  }
};

actions.updateProposalApprovals = async (payload) => {
  const { account, token, callingContractInfo } = payload;

  if (callingContractInfo === undefined) return;
  if (callingContractInfo.name !== 'tokens') return;

  const acct = await api.db.findOne('accounts', { account });
  if (acct !== null) {
    // calculate approval weight of the account
    const balance = await api.db.findOneInTable('tokens', 'balances', { account, symbol: token.symbol });
    let approvalWeight = 0;
    if (balance && balance.stake) {
      approvalWeight = balance.stake;
    }

    if (balance && balance.delegationsIn) {
      approvalWeight = api.BigNumber(approvalWeight)
        .plus(balance.delegationsIn)
        .toFixed(token.precision, api.BigNumber.ROUND_HALF_UP);
    }

    const wIndex = acct.weights.findIndex(x => x.symbol === token.symbol);
    let oldApprovalWeight = 0;
    if (wIndex !== -1) {
      oldApprovalWeight = acct.weights[wIndex].weight;
      acct.weights[wIndex].weight = approvalWeight;
    } else {
      acct.weights.push({ symbol: token.symbol, weight: approvalWeight });
    }

    const deltaApprovalWeight = api.BigNumber(approvalWeight)
      .minus(oldApprovalWeight)
      .dp(token.precision, api.BigNumber.ROUND_HALF_UP);

    if (!api.BigNumber(deltaApprovalWeight).eq(0)) {
      await api.db.update('accounts', acct);
      const approvals = await api.db.find('approvals', { from: account });
      for (let index = 0; index < approvals.length; index += 1) {
        const approval = approvals[index];
        await updateProposalWeight(approval.to, deltaApprovalWeight);
      }
    }
  }
};

async function checkPendingProposals(dtf, params) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const payTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: dtf.payToken });
  // ratio of daily payment independent of dtfTickHours
  const passedTimeSec = api.BigNumber(blockDate.getTime()).minus(dtf.lastTickTime).dividedBy(1000);
  const tickPayRatio = passedTimeSec.dividedBy(86400);

  const funded = [];
  const fundedLog = [];
  let offset = 0;
  let proposals;
  let runningPay = api.BigNumber(dtf.maxAmountPerDay);
  while (runningPay.gt(0)) {
    proposals = await api.db.find('proposals',
      {
        fundId: dtf.id,
        active: true,
        approvalWeight: { $gt: api.BigNumber(dtf.voteThreshold).toNumber() },
        startDate: { $lte: blockDate.toISOString() },
        endDate: { $gte: blockDate.toISOString() },
      },
      params.processQueryLimit,
      offset,
      [{ index: 'approvalWeight', descending: true }, { index: '_id', descending: false }]);

    for (let i = 0; i < proposals.length; i += 1) {
      if (api.BigNumber(proposals[i].amountPerDay).times(tickPayRatio).gte(runningPay)) {
        proposals[i].tickPay = runningPay.toFixed(payTokenObj.precision, api.BigNumber.ROUND_DOWN);
        funded.push(proposals[i]);
        runningPay = 0;
        break;
      } else {
        proposals[i].tickPay = api.BigNumber(proposals[i].amountPerDay)
          .times(tickPayRatio)
          .toFixed(payTokenObj.precision, api.BigNumber.ROUND_DOWN);
        funded.push(proposals[i]);
        runningPay = runningPay.minus(proposals[i].amountPerDay);
      }
    }
    if (proposals.length < params.processQueryLimit) break;
    offset += params.processQueryLimit;
  }

  for (let i = 0; i < funded.length; i += 1) {
    const fund = funded[i];
    fundedLog.push({ id: fund._id, tickPay: fund.tickPay });
    if (fund.payout.type === 'user') {
      await api.executeSmartContract('tokens', 'issue',
        { to: fund.payout.name, symbol: payTokenObj.symbol, quantity: fund.tickPay });
    } else if (fund.payout.type === 'contract') {
      await api.executeSmartContract('tokens', 'issueToContract',
        { to: fund.payout.name, symbol: payTokenObj.symbol, quantity: fund.tickPay });
      await api.executeSmartContract(fund.payout.name, 'receiveDtfTokens',
        { data: fund.payout.contractPayload, symbol: payTokenObj.symbol, quantity: fund.tickPay });
    }
  }
  // eslint-disable-next-line no-param-reassign
  dtf.lastTickTime = api.BigNumber(blockDate.getTime()).toNumber();
  await api.db.update('funds', dtf);
  api.emit('fundProposals', { fundId: dtf.id, funded: fundedLog });
}

actions.checkPendingDtfs = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const params = await api.db.findOne('params', {});
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const tickTime = api.BigNumber(blockDate.getTime()).minus(params.dtfTickHours * 3600 * 1000).toNumber();

    const pendingDtfs = await api.db.find('funds',
      {
        active: true,
        lastTickTime: {
          $lte: tickTime,
        },
      },
      params.maxDtfsPerBlock,
      0,
      [{ index: 'lastTickTime', descending: false }, { index: '_id', descending: false }]);

    for (let i = 0; i < pendingDtfs.length; i += 1) {
      await checkPendingProposals(pendingDtfs[i], params);
    }
  }
};
