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
    await api.db.createTable('proposals', [
      'fundId',
      { name: 'byApprovalWeight', index: { fundId: 1, approvalWeight: 1 } },
    ]);
    await api.db.createTable('approvals', ['from', 'to']);
    await api.db.createTable('accounts', [], { primaryKey: ['account'] });
    await api.db.createTable('params');

    const params = {};
    params.dtfCreationFee = '1000';
    params.dtfUpdateFee = '300';
    params.dtfTickHours = '24';
    params.maxDtfsPerBlock = 40;
    params.maxAccountApprovals = 50;
    params.processQueryLimit = 1000;
    await api.db.insert('params', params);
  } else {
    const params = await api.db.findOne('params', {});
    if (!params.updateIndex) {
      const dtfs = await api.db.find('funds', {});
      const voteTokens = new Set();
      for (let i = 0; i < dtfs.length; i += 1) {
        voteTokens.add(dtfs[i].voteToken);
      }
      const resetAccounts = await api.db.find('accounts', {});
      for (let i = 0; i < resetAccounts.length; i += 1) {
        const acct = resetAccounts[i];
        acct.weights = acct.weights.filter(ele => voteTokens.has(ele.symbol));
        await api.db.update('accounts', acct);
      }
      const resetProposals = await api.db.find('proposals', {});
      for (let i = 0; i < resetProposals.length; i += 1) {
        const prop = resetProposals[i];
        const propFund = dtfs.find(x => x.id === prop.fundId);
        const propApprovals = await api.db.find('approvals', { to: prop._id });
        let newApprovalWeight = api.BigNumber('0');
        for (let j = 0; j < propApprovals.length; j += 1) {
          const approval = propApprovals[j];
          const approvalAcct = resetAccounts.find(x => x.account === approval.from);
          const approvalAcctWgt = approvalAcct.weights.find(x => x.symbol === propFund.voteToken);
          newApprovalWeight = newApprovalWeight.plus(approvalAcctWgt.weight);
        }
        prop.approvalWeight = { $numberDecimal: newApprovalWeight };
        await api.db.update('proposals', prop);
      }
      params.updateIndex = 1;
      await api.db.update('params', params);
    }
  }
};

actions.updateParams = async (payload) => {
  const {
    dtfCreationFee,
    dtfUpdateFee,
    dtfTickHours,
    maxDtfsPerBlock,
    maxAccountApprovals,
    processQueryLimit,
  } = payload;

  if (api.sender !== api.owner) return;
  const params = await api.db.findOne('params', {});
  if (dtfCreationFee) {
    if (!api.assert(typeof dtfCreationFee === 'string' && !api.BigNumber(dtfCreationFee).isNaN() && api.BigNumber(dtfCreationFee).gte(0), 'invalid dtfCreationFee')) return;
    params.dtfCreationFee = dtfCreationFee;
  }
  if (dtfUpdateFee) {
    if (!api.assert(typeof dtfUpdateFee === 'string' && !api.BigNumber(dtfUpdateFee).isNaN() && api.BigNumber(dtfUpdateFee).gte(0), 'invalid dtfUpdateFee')) return;
    params.dtfUpdateFee = dtfUpdateFee;
  }
  if (dtfTickHours) {
    if (!api.assert(typeof dtfTickHours === 'string' && api.BigNumber(dtfTickHours).isInteger() && api.BigNumber(dtfTickHours).gte(1), 'invalid dtfTickHours')) return;
    params.dtfTickHours = dtfTickHours;
  }
  if (maxDtfsPerBlock) {
    if (!api.assert(typeof maxDtfsPerBlock === 'string' && api.BigNumber(maxDtfsPerBlock).isInteger() && api.BigNumber(maxDtfsPerBlock).gte(1), 'invalid maxDtfsPerBlock')) return;
    params.maxDtfsPerBlock = api.BigNumber(maxDtfsPerBlock).toNumber();
  }
  if (maxAccountApprovals) {
    if (!api.assert(typeof maxAccountApprovals === 'string' && api.BigNumber(maxAccountApprovals).isInteger() && api.BigNumber(maxAccountApprovals).gte(1), 'invalid maxDtfsPerBlock')) return;
    params.maxAccountApprovals = api.BigNumber(maxAccountApprovals).toNumber();
  }
  if (processQueryLimit) {
    if (!api.assert(typeof processQueryLimit === 'string' && api.BigNumber(processQueryLimit).isInteger() && api.BigNumber(processQueryLimit).gte(1), 'invalid processQueryLimit')) return;
    params.processQueryLimit = api.BigNumber(processQueryLimit).toNumber();
  }
  await api.db.update('params', params);
};

function validateTokens(payTokenObj, voteTokenObj) {
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

function validateDateChange(proposal, newDate, maxDays) {
  if (!api.assert(validateDateTime(newDate), 'invalid datetime format: YYYY-MM-DDThh:mm:ss.sssZ')) return false;
  const start = new Date(proposal.startDate);
  const cur = new Date(proposal.endDate);
  const repl = new Date(newDate);
  if (!api.assert(api.BigNumber(start.getTime()).lt(api.BigNumber(repl.getTime()).minus(86400 * 1000)), 'dates must be at least 1 day apart')) return false;
  if (!api.assert(repl <= cur, 'date can only be reduced')) return false;
  const range = api.BigNumber(start.getTime()).minus(repl.getTime()).abs();
  const rangeDays = range.dividedBy(1000 * 60 * 60 * 24).toFixed(0, api.BigNumber.ROUND_CEIL);
  if (!api.assert(api.BigNumber(rangeDays).lte(maxDays), 'date range exceeds DTF maxDays')) return false;
  return true;
}

function validatePending(proposal) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  return new Date(proposal.endDate) >= blockDate;
}

async function updateProposalWeight(id, deltaApprovalWeight, deltaToken = null) {
  const proposal = await api.db.findOne('proposals', { _id: id });
  if (proposal && validatePending(proposal)) {
    if (deltaToken) {
      const dtf = await api.db.findOne('funds', { id: proposal.fundId });
      if (dtf.voteToken !== deltaToken.symbol) return true;
    }
    proposal.approvalWeight = { $numberDecimal: api.BigNumber(proposal.approvalWeight.$numberDecimal).plus(deltaApprovalWeight) };
    await api.db.update('proposals', proposal);
    return true;
  }
  return false;
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
    if (!validateTokens(payTokenObj, voteTokenObj)
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
    newDtf.id = `${payToken}:${voteToken}`;
    const existingDtf = await api.db.findOne('funds', { id: newDtf.id });
    if (!api.assert(!existingDtf, 'DTF already exists')) return;

    const insertedDtf = await api.db.insert('funds', newDtf);

    // burn the token creation fees
    if (api.sender !== api.owner
        && api.sender !== 'null'
        && api.BigNumber(dtfCreationFee).gt(0)) {
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

  const authorizedUpdate = api.BigNumber(dtfUpdateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(dtfUpdateFee);

  if (api.assert(authorizedUpdate, 'you must have enough tokens to cover the update fee')
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
    existingDtf.voteThreshold = voteThreshold;
    existingDtf.maxDays = maxDays;
    existingDtf.maxAmountPerDay = maxAmountPerDay;
    if (proposalFee) existingDtf.proposalFee = proposalFee;
    await api.db.update('funds', existingDtf);

    // burn the token update fees
    if (api.sender !== api.owner
        && api.sender !== 'null'
        && api.BigNumber(dtfUpdateFee).gt(0)) {
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
    authorPermlink, payout, isSignedWithActiveKey,
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
    && api.assert(typeof authorPermlink === 'string' && authorPermlink.length > 0 && authorPermlink.length <= 255, 'invalid authorPermlink: between 1 and 255 characters')
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
      authorPermlink,
      payout,
      creator: api.sender,
      approvalWeight: { $numberDecimal: '0' },
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
    authorPermlink, isSignedWithActiveKey,
  } = payload;

  if (!api.assert(typeof id === 'string' && api.BigNumber(id).isInteger(), 'invalid id')) return;
  const proposal = await api.db.findOne('proposals', { _id: api.BigNumber(id).toNumber() });
  if (!api.assert(proposal, 'proposal does not exist')
    || !api.assert(proposal.creator === api.sender || api.owner === api.sender, 'must be proposal creator')) return;
  const dtf = await api.db.findOne('funds', { id: proposal.fundId, active: true });
  if (!api.assert(dtf, 'DTF does not exist or inactive')) return;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(dtf.active === true, 'DTF is not active')
    && api.assert(proposal.active === true, 'proposal is not active')
    && api.assert(typeof title === 'string' && title.length > 0 && title.length <= 80, 'invalid title: between 1 and 80 characters')
    && api.assert(typeof authorPermlink === 'string' && authorPermlink.length > 0 && authorPermlink.length <= 255, 'invalid authorPermlink: between 1 and 255 characters')
    && api.assert(typeof amountPerDay === 'string'
      && api.BigNumber(amountPerDay).isInteger()
      && api.BigNumber(amountPerDay).gt(0)
      && api.BigNumber(amountPerDay).lte(proposal.amountPerDay), 'invalid amountPerDay: greater than 0 and cannot be increased')
    && api.assert(api.BigNumber(amountPerDay).lte(dtf.maxAmountPerDay), 'invalid amountPerDay: exceeds DTF maxAmountPerDay')
    && validateDateChange(proposal, endDate, dtf.maxDays)) {
    proposal.title = title;
    proposal.endDate = endDate;
    proposal.amountPerDay = amountPerDay;
    proposal.authorPermlink = authorPermlink;
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
  const params = await api.db.findOne('params', {});

  if (api.assert(typeof id === 'string' && api.BigNumber(id).isInteger(), 'invalid id')) {
    const proposal = await api.db.findOne('proposals', { _id: api.BigNumber(id).toNumber() });

    if (api.assert(proposal, 'proposal does not exist')
      && api.assert(validatePending(proposal), 'proposal is not pending')) {
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

      let activeApprovals = 0;
      const approvals = await api.db.find('approvals',
        { from: api.sender, proposalPending: true },
        params.maxAccountApprovals,
        0,
        [{ index: '_id', descending: true }]);
      for (let index = 0; index < approvals.length; index += 1) {
        const approval = approvals[index];
        const approvalProposal = await api.db.findOne('proposals', { _id: approval.to });
        if (approvalProposal && validatePending(approvalProposal)) {
          activeApprovals += 1;
        } else {
          approval.proposalPending = false;
          await api.db.update('approvals', approval);
        }
      }
      if (!api.assert(activeApprovals < params.maxAccountApprovals, `you can only approve ${params.maxAccountApprovals} active proposals`)) return;

      let approval = await api.db.findOne('approvals', { from: api.sender, to: proposal._id });
      if (api.assert(approval === null, 'you already approved this proposal')) {
        approval = {
          from: api.sender,
          to: proposal._id,
          proposalPending: true,
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
    if (api.assert(proposal, 'proposal does not exist')
      && api.assert(validatePending(proposal), 'proposal is not pending')) {
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
        if (wIndex !== -1) {
          acct.weights[wIndex].weight = approvalWeight;
        } else {
          acct.weights.push({ symbol: dtf.voteToken, weight: approvalWeight });
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
    const params = await api.db.findOne('params', {});

    // only update existing weights
    const wIndex = acct.weights.findIndex(x => x.symbol === token.symbol);
    if (wIndex !== -1) {
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

      let oldApprovalWeight = 0;
      oldApprovalWeight = acct.weights[wIndex].weight;
      acct.weights[wIndex].weight = approvalWeight;

      const deltaApprovalWeight = api.BigNumber(approvalWeight)
        .minus(oldApprovalWeight)
        .dp(token.precision, api.BigNumber.ROUND_HALF_UP);

      if (!api.BigNumber(deltaApprovalWeight).eq(0)) {
        await api.db.update('accounts', acct);
        const approvals = await api.db.find('approvals',
          { from: account, proposalPending: true },
          params.maxAccountApprovals,
          0,
          [{ index: '_id', descending: true }]);
        for (let index = 0; index < approvals.length; index += 1) {
          const approval = approvals[index];
          const proposalPending = await updateProposalWeight(approval.to, deltaApprovalWeight, token);
          if (!proposalPending) {
            approval.proposalPending = false;
            await api.db.update('approvals', approval);
          }
        }
      }
    }
  }
};

async function checkPendingProposals(dtf, params) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const payTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: dtf.payToken });
  const tickPayRatio = api.BigNumber(params.dtfTickHours).dividedBy(24);

  const funded = [];
  const fundedLog = [];
  let offset = 0;
  let proposals;
  let runningPay = api.BigNumber(dtf.maxAmountPerDay).times(tickPayRatio);
  while (runningPay.gt(0)) {
    proposals = await api.db.find('proposals',
      {
        fundId: dtf.id,
        active: true,
        approvalWeight: { $gt: { $numberDecimal: api.BigNumber(dtf.voteThreshold) } },
        startDate: { $lte: blockDate.toISOString() },
        endDate: { $gte: blockDate.toISOString() },
      },
      params.processQueryLimit,
      offset,
      [{ index: 'byApprovalWeight', descending: true }, { index: '_id', descending: false }]);

    for (let i = 0; i < proposals.length; i += 1) {
      if (api.BigNumber(proposals[i].amountPerDay).times(tickPayRatio).gte(runningPay)) {
        proposals[i].tickPay = runningPay.toFixed(payTokenObj.precision, api.BigNumber.ROUND_DOWN);
        funded.push(proposals[i]);
        runningPay = api.BigNumber(0);
        break;
      } else {
        proposals[i].tickPay = api.BigNumber(proposals[i].amountPerDay)
          .times(tickPayRatio)
          .toFixed(payTokenObj.precision, api.BigNumber.ROUND_DOWN);
        funded.push(proposals[i]);
        runningPay = runningPay.minus(proposals[i].tickPay);
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
