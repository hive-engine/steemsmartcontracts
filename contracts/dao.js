/* eslint-disable no-await-in-loop */
/* eslint-disable no-underscore-dangle */
/* eslint-disable max-len */
/* global actions, api */

const FeeMethod = ['burn', 'issuer'];
const PayoutType = ['user', 'contract'];

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('daos');
  if (tableExists === false) {
    await api.db.createTable('daos', ['id', 'baseToken']);
    await api.db.createTable('proposals', ['daoId', 'approvalWeight']);
    await api.db.createTable('approvals', ['from', 'to']);
    await api.db.createTable('accounts', ['account']);
    await api.db.createTable('params');

    const params = {
      daoCreationFee: '1000',
      daoTickHours: '24',
      maxDaosPerBlock: 40,
    };
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  const { daoCreationFee, daoTickHours } = payload;
  if (api.sender !== api.owner) return;
  const params = await api.db.findOne('params', {});
  if (daoCreationFee) {
    if (!api.assert(typeof daoCreationFee === 'string' && !api.BigNumber(daoCreationFee).isNaN() && api.BigNumber(daoCreationFee).gte(0), 'invalid daoCreationFee')) return;
    params.daoCreationFee = daoCreationFee;
  }
  if (daoTickHours) {
    if (!api.assert(typeof daoTickHours === 'string' && api.BigNumber(daoTickHours).isInteger() && api.BigNumber(daoTickHours).gte(1), 'invalid daoTickHours')) return;
    params.daoTickHours = daoTickHours;
  }
  await api.db.update('params', params);
};

// validate max supply

function generateDaoId(dao) {
  return `${dao.baseToken.replace('.', '-')}:${dao.voteToken.replace('.', '-')}`;
}

async function updateProposalWeight(id, token, approvalWeight) {
  const proposal = await api.db.findOne('proposals', { id });
  if (proposal) {
    proposal.approvalWeight = api.BigNumber(proposal.approvalWeight).plus(approvalWeight).toFixed(token.precision);
    await api.db.update('proposals', proposal);
  }
}

async function validateTokens(baseTokenObj, voteTokenObj) {
  if (!api.assert(baseTokenObj && (baseTokenObj.issuer === api.sender
    // eslint-disable-next-line no-template-curly-in-string
    || (baseTokenObj.symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" && api.sender === api.owner)), 'must be issuer of baseToken')) return false;
  if (!api.assert(voteTokenObj && voteTokenObj.stakingEnabled, 'voteToken must have staking enabled')) return false;
  return true;
}

function validateDateTime(str) {
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(str);
}

function validateDateRange(startDate, endDate, maxDays) {
  if (!api.assert(validateDateTime(startDate) && validateDateTime(endDate), 'invalid datetime format: YYYY-MM-DDThh:mm:ss.sssZ')) return false;
  const now = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (!api.assert(start > end, 'start date greater than end date')) return false;
  if (!api.assert(api.BigNumber(start.getTime()).lt(api.BigNumber(now.getTime()).plus(86400 * 1000))
    || api.BigNumber(end.getTime()).lt(api.BigNumber(now.getTime()).plus(86400 * 1000)), 'dates must be at least 1 day in the future')) return false;
  const range = api.BigNumber(start.getTime()).minus(end.getTime()).abs();
  const rangeDays = range.dividedBy(1000 * 60 * 60 * 24).toFixed(0, api.BigNumber.ROUND_CEIL);
  if (!api.assert(rangeDays.lte(maxDays), 'date range exceeds DAO maxDays')) return false;
  return true;
}

actions.createDao = async (payload) => {
  const {
    baseToken, voteToken, voteThreshold, maxDays, maxAmountPerDay, proposalFee, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { daoCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(daoCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(daoCreationFee);

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
    const baseTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: baseToken });
    const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: voteToken });
    if (!await validateTokens(baseTokenObj, voteTokenObj)
      || !api.assert(api.BigNumber(maxAmountPerDay).dp() <= baseTokenObj.precision, 'maxAmountPerDay precision mismatch')
      || !api.assert(api.BigNumber(voteThreshold).dp() <= voteTokenObj.precision, 'voteThreshold precision mismatch')) return;

    const newDao = {
      baseToken,
      voteToken,
      voteThreshold,
      maxDays,
      maxAmountPerDay,
      proposalFee,
      active: false,
      creator: api.sender,
    };
    newDao.id = generateDaoId(newDao);
    const insertedDao = await api.db.insert('daos', newDao);

    // burn the token creation fees
    if (api.sender !== api.owner && api.BigNumber(daoCreationFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: daoCreationFee, isSignedWithActiveKey,
      });
    }
    api.emit('createDao', { id: insertedDao.id });
  }
};

actions.setDaoActive = async (payload) => {
  const {
    id,
    active,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    return;
  }
  const dao = await api.db.findOne('daos', { id });
  if (api.assert(dao, 'DAO does not exist')
    && api.assert(dao.creator === api.sender || api.owner === api.sender, 'must be DAO creator')) {
    dao.active = !!active;
    await api.db.update('daos', dao);
  }
};

actions.createProposal = async (payload) => {
  const {
    daoId, title, startDate, endDate, amountPerDay,
    authorperm, payout, isSignedWithActiveKey,
  } = payload;

  const dao = await api.db.findOne('daos', { id: daoId });
  if (!api.assert(dao, 'DAO does not exist')) return;

  let authorizedCreation = true;
  if (dao.proposalFee) {
    const feeTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: dao.proposalFee.symbol });
    authorizedCreation = api.BigNumber(dao.proposalFee.amount).lte(0) || api.sender === api.owner
      ? true
      : feeTokenBalance && api.BigNumber(feeTokenBalance.balance).gte(dao.proposalFee.amount);
  }

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(dao.active === true, 'DAO is not active')
    && api.assert(typeof title === 'string' && title.length > 0 && title.length <= 80, 'invalid title: between 1 and 80 characters')
    && api.assert(typeof authorperm === 'string', 'invalid authorperm')
    && api.assert(typeof amountPerDay === 'string'
      && api.BigNumber(amountPerDay).isInteger()
      && api.BigNumber(amountPerDay).gt(0), 'invalid amountPerDay: greater than 0')
    && api.assert(typeof payout === 'object'
      && typeof payout.type === 'string' && PayoutType.indexOf(payout.type) !== -1
      && typeof payout.name === 'string', 'invalid payout settings')
    && validateDateRange(startDate, endDate, dao.maxDays)) {
    const newProposal = {
      daoId,
      title,
      startDate,
      endDate,
      amountPerDay,
      authorperm,
      payout,
      creator: api.sender,
    };
    const insertedProposal = await api.db.insert('proposals', newProposal);

    if (api.sender !== api.owner && dao.proposalFee) {
      if (dao.proposalFee.method === 'burn') {
        await api.executeSmartContract('tokens', 'transfer', {
          to: 'null', symbol: dao.proposalFee.symbol, quantity: dao.proposalFee.amount,
        });
      } else if (dao.proposalFee.method === 'issuer') {
        const feeTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: dao.proposalFee.symbol });
        await api.executeSmartContract('tokens', 'transfer', {
          to: feeTokenObj.issuer, symbol: dao.proposalFee.symbol, quantity: dao.proposalFee.amount,
        });
      }
    }
    api.emit('createProposal', { id: insertedProposal._id });
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
        .toFixed(token.precision);
    }

    const oldApprovalWeight = acct.approvalWeight;

    const deltaApprovalWeight = api.BigNumber(approvalWeight)
      .minus(oldApprovalWeight)
      .toFixed(token.precision);

    acct.approvalWeight = approvalWeight;

    if (!api.BigNumber(deltaApprovalWeight).eq(0)) {
      await api.db.update('accounts', acct);

      const approvals = await api.db.find('approvals', { from: account });

      for (let index = 0; index < approvals.length; index += 1) {
        const approval = approvals[index];
        await updateProposalWeight(approval.to, token, deltaApprovalWeight);
      }
    }
  }
};

async function runDao(dao, params) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const funded = [];
  const baseTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: dao.baseToken });

  api.emit('daoProposals', { daoId: dao.id, funded });
  for (let i = 0; i < funded.length; i += 1) {
    const fund = funded[i];
    if (fund.payout.type === 'user') {
      await api.executeSmartContract('tokens', 'issue',
        { to: fund.payout.name, symbol: baseTokenObj.symbol, quantity: 1 });
    } else if (fund.payout.type === 'contract') {
      await api.executeSmartContract('tokens', 'issueToContract',
        { to: fund.payout.name, symbol: baseTokenObj.symbol, quantity: 1 });
    }
  }
  // eslint-disable-next-line no-param-reassign
  dao.lastTickTime = api.BigNumber(blockDate.getTime()).toNumber();
  await api.db.update('daos', dao);
}

actions.checkPendingProposals = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const params = await api.db.findOne('params', {});
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const tickTime = api.BigNumber(blockDate.getTime()).minus(params.daoTickHours * 3600 * 1000).toNumber();

    const pendingDaos = await api.db.find('daos',
      {
        active: true,
        lastTickTime: {
          $lte: tickTime,
        },
      },
      params.maxDaosPerBlock,
      0);

    for (let i = 0; i < pendingDaos.length; i += 1) {
      const dao = pendingDaos[i];
      await runDao(dao, params);
    }
  }
};
