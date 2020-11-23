/* eslint-disable no-await-in-loop, max-len */
/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
/* global actions, api */

const DUST_WEIGHT = 1;
const MAX_RECIPIENTS = 40;
const VOTES_PER_ROLE = 1;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('batches');
  if (tableExists === false) {
    await api.db.createTable('batches');
    await api.db.createTable('params');

    const params = {};
    params.distCreationFee = '750';
    params.distUpdateFee = '500';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    distCreationFee,
    distUpdateFee,
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

      // In the unlikely condition where the transfer fails we will keep the share leftover for the next run
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

/*
"roles": [
  {"name": "President", "description": "El Presidente", "pct": 50, "primary": 1},
  {"name": "Vice President", "description": "El Presidente Jr.", "pct": 25, "primary": 2},
  {"name": "Developer", "description": "Responsible for xxxxx", "pct": 25, "primary": 4},
]
*/
async function validateRoles(roles) {
  if (!api.assert(roles && Array.isArray(roles), 'roles must be an array')) return false;
  if (!api.assert(roles.length >= 1, 'specify at least one role')) return false;

  const rolesNames = new Set();
  let roleTotalShare = 0;
  let roleTotalPrimary = 0;
  for (let i = 0; i < roles.length; i += 1) {
    const rolesConfig = roles[i];
    if (!api.assert(rolesConfig && rolesConfig.name
      && typeof (rolesConfig.name) === 'string' && rolesConfig.name.length <= 255, 'roles name invalid')) return false;

    if (!api.assert(!rolesNames.has(rolesConfig.name), 'roles cannot have duplicate names')) return false;
    rolesNames.add(rolesConfig.name);

    if (!api.assert(rolesConfig && rolesConfig.description
      && typeof (rolesConfig.description) === 'string' && rolesConfig.description.length <= 255, 'roles description invalid')) return false;

    if (!api.assert(Number.isInteger(rolesConfig.pct)
      && rolesConfig.pct >= 1 && rolesConfig.pct <= 100, 'roles pct must be an integer from 1 to 100')) return false;

    if (!api.assert(Number.isInteger(rolesConfig.pct)
      && rolesConfig.primary >= 1 && rolesConfig.primary <= MAX_RECIPIENTS, `roles primary must be an integer from 1 to ${MAX_RECIPIENTS}`)) return false;

    roleTotalShare += rolesConfig.pct;
    roleTotalPrimary += rolesConfig.primary;
  }
  if (!api.assert(roleTotalShare === 100, 'roles pct must total 100')) return false;
  if (!api.assert(roleTotalPrimary <= MAX_RECIPIENTS, `total of roles primary must not exceed ${MAX_RECIPIENTS}`)) return false;
  return true;
}

async function updateStakeWeight(distOrId) {
  const dist = typeof (distOrId) !== 'object' ? await api.db.findOne('batches', { _id: distOrId }) : distOrId;
  const stakeToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: dist.stakeSymbol });

  // update voting weight for all voters in this distribution
  for (let i = 0; i < dist.voters.length; i += 1) {
    const balance = await api.db.findOneInTable('tokens', 'balances', { account: dist.voters[i].account, symbol: stakeToken.symbol });
    let voteWeight = 0;
    if (balance && balance.stake) {
      voteWeight = balance.stake;
    }

    if (balance && balance.pendingUnstake) {
      voteWeight = api.BigNumber(voteWeight)
        .plus(balance.pendingUnstake)
        .toFixed(stakeToken.precision);
    }

    if (balance && balance.delegationsIn) {
      voteWeight = api.BigNumber(voteWeight)
        .plus(balance.delegationsIn)
        .toFixed(stakeToken.precision);
    }

    const oldvoteWeight = dist.voters[i].weight;
    const deltavoteWeight = api.BigNumber(voteWeight)
      .minus(oldvoteWeight)
      .toFixed(stakeToken.precision);

    dist.voters[i].weight = voteWeight;

    // update candidates if weight has changed
    if (!api.BigNumber(deltavoteWeight).eq(0)) {
      dist.votes.forEach((x) => {
        if (x.from === dist.voters[i].account) {
          const cIndex = dist.candidates.findIndex(c => c.account === x.to);
          dist.candidates[cIndex].weight = api.BigNumber(dist.candidates[cIndex].weight)
            .plus(deltavoteWeight)
            .toFixed(stakeToken.precision);
        }
      });
    }
  }
  await api.db.update('batches', dist);
}

function validateIncomingToken(batch, symbol) {
  for (let i = 0; i < batch.tokenMinPayout.length; i += 1) {
    if (batch.tokenMinPayout[i].symbol === symbol) return true;
  }
  return false;
}

actions.create = async (payload) => {
  const {
    roles, stakeSymbol, isSignedWithActiveKey,
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
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    if (await validateRoles(roles) && api.assert(typeof (stakeSymbol) === 'string' && stakeSymbol.length > 0, 'stakeSymbol invalid')) {
      const newDist = {
        roles,
        candidates: [],
        votes: [],
        voters: [],
        stakeSymbol,
        active: false,
        creator: api.sender,
      };
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
  }
};

// allow owner/creator to manually distribute a token
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
    id, roles, isSignedWithActiveKey,
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
    if (api.assert(exDist, 'distributionroles not found') && await validateRoles(roles)) {
      exDist.roles = roles;
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
  if (api.assert(dist, 'distributionroles id not found')
    && api.assert(dist.creator === api.sender || api.owner === api.sender, 'you must be the creator of this distributionroles')) {
    dist.active = !!active;
    await api.db.update('batches', dist);
  }
};

actions.apply = async (payload) => {
  const {
    id, role,
  } = payload;

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to deposit')) {
    const roleExist = dist.roles.find(x => x.name === role);
    if (api.assert(roleExist, 'role not found')) {
      dist.candidates.push({
        account: api.sender,
        role,
        weight: 0,
      });
      await api.db.update('batches', dist);
      api.emit('apply', { id, account: api.sender, role });
    }
  }
};

actions.resign = async (payload) => {
  const {
    id, role,
  } = payload;

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to deposit')) {
    const roleExist = dist.roles.find(x => x.name === role);
    if (api.assert(roleExist, 'role not found')) {
      const cIndex = dist.candidates.findIndex(x => x.account === api.sender);
      if (api.assert(cIndex !== -1, 'no candidacy found for this role')) {
        dist.candidates.splice(cIndex, 1);
        await api.db.update('batches', dist);
        api.emit('resign', { id, account: api.sender, role });
      }
    }
  }
};

actions.vote = async (payload) => {
  const {
    id, role, to,
  } = payload;

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to deposit'
    && api.assert(dist.candidates.find(x => x.role === role && x.account === to), 'role or candidate not found in this distribution'))) {
    const votes = dist.votes.find(x => x.role === role && x.from === api.sender);
    if (api.assert(votes === undefined || votes.length < VOTES_PER_ROLE, `you cannot vote more than ${VOTES_PER_ROLE} candidate(s) per role`)) {
      dist.votes.push({
        role,
        from: api.sender,
        to,
      });

      const voterExist = dist.voters.find(x => x.account === api.sender);
      if (!voterExist) {
        dist.voters.push({
          account: api.sender,
          weight: 0,
        });
      }
      await updateStakeWeight(dist);
      api.emit('vote', { from: api.sender, to });
    }
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
    const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: 'distributionroles' });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'distributionroles' && el.data.quantity === quantity) !== undefined) {
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
