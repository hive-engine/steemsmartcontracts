/* eslint-disable no-await-in-loop, max-len */
/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
/* global actions, api */

const DUST_PCT = 0.01;
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
  dist.dustWeight = api.BigNumber(stakeToken.supply).multipliedBy(DUST_PCT);

  for (let i = 0; i < dist.candidates.length; i += 1) {
    dist.candidates[i].weight = 0;
  }

  // update voting weight for all voters
  for (let i = 0; i < dist.voters.length; i += 1) {
    const v = dist.voters[i];
    const balance = await api.db.findOneInTable('tokens', 'balances', { account: v.account, symbol: stakeToken.symbol });
    let voteWeight = 0;
    if (balance && balance.stake) {
      voteWeight = balance.stake;
    }

    if (balance && balance.delegationsIn) {
      voteWeight = api.BigNumber(voteWeight)
        .plus(balance.delegationsIn)
        .toFixed(stakeToken.precision);
    }
    v.weight = voteWeight;

    // update candidates
    const vVotes = dist.votes.filter(x => x.from === v.account);
    for (let j = 0; j < vVotes.length; j += 1) {
      const x = vVotes[j];
      const cIndex = dist.candidates.findIndex(c => c.account === x.to);
      dist.candidates[cIndex].weight = api.BigNumber(dist.candidates[cIndex].weight)
        .plus(voteWeight)
        .toFixed(stakeToken.precision);
    }
  }
  await api.db.update('batches', dist);
}

function validateIncomingToken(dist, symbol) {
  if (dist.stakeSymbol === symbol) return true;
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
        dustWeight: 0,
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
    const dist = await api.db.findOne('batches', { _id: id });
    if (api.assert(dist, 'distributionroles not found') && await validateRoles(roles)) {
      dist.roles = roles;

      // remove vote history for removed roles
      dist.votes = dist.votes.reduce((p, c) => {
        if (dist.roles.findIndex(y => y.name === c.role) !== -1) p.push(c); return p;
      }, []);

      // remove dangling voters
      dist.voters = dist.voters.reduce((p, c) => {
        if (dist.votes.findIndex(y => y.from === c.account) !== -1) p.push(c); return p;
      }, []);

      await api.db.update('batches', dist);

      // burn the token creation fees
      if (api.sender !== api.owner && api.BigNumber(distUpdateFee).gt(0)) {
        await api.executeSmartContract('tokens', 'transfer', {
          // eslint-disable-next-line no-template-curly-in-string
          to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: distUpdateFee, isSignedWithActiveKey,
        });
      }
      api.emit('update', { id: dist._id });
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
        // remove candidate
        dist.candidates.splice(cIndex, 1);

        // remove vote history
        dist.votes = dist.votes.reduce((p, c) => {
          if (c.to !== api.sender && c.role !== role) p.push(c); return p;
        }, []);

        // remove dangling voters
        dist.voters = dist.voters.reduce((p, c) => {
          if (dist.votes.findIndex(y => y.from === c.account) !== -1) p.push(c); return p;
        }, []);

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
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to vote')
    && api.assert(dist.candidates.find(x => x.role === role && x.account === to), 'role or candidate not found in this distribution')) {
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

actions.unvote = async (payload) => {
  const {
    id, role, to,
  } = payload;

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to vote')
    && api.assert(dist.candidates.find(x => x.role === role && x.account === to), 'role or candidate not found in this distribution')) {
    const voteIndex = dist.votes.findIndex(x => x.role === role && x.to === to && x.from === api.sender);
    if (api.assert(voteIndex !== -1, 'already unvoted')) {
      dist.votes.splice(voteIndex, 1);

      // remove voter if no other votes
      const votesExist = dist.votes.find(x => x.from === api.sender);
      if (votesExist === undefined) {
        const voterIndex = dist.voters.findIndex(x => x.account === api.sender);
        dist.voters.splice(voterIndex, 1);
      }

      await updateStakeWeight(dist);
      api.emit('unvote', { from: api.sender, to });
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
  const stakeToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: dist.stakeSymbol });
  if (api.assert(dist, 'distributionroles id not found') && api.assert(dist.active, 'distributionroles must be active to deposit')
    && api.assert(validateIncomingToken(dist, symbol), `${symbol} is not accepted by this distributionroles`)) {
    // deposit requested tokens to contract
    const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: 'distributionroles' });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'distributionroles' && el.data.quantity === quantity) !== undefined) {
      // add pending balance on contract to distribution, if any
      const exBalance = await api.db.findOne({
        contract: 'tokens',
        table: 'contractsBalances',
        query: { account: 'distributionroles', symbol },
      });
      const balance = exBalance !== null ? exBalance.balance + quantity : quantity;

      // update weights
      await updateStakeWeight(dist);

      // distribute deposit by role
      for (let r = 0; r < dist.roles.length; r += 1) {
        const rolePay = api.BigNumber(balance).multipliedBy(dist.roles[r].pct).dividedBy(100).toFixed(stakeToken.precision);
        const cands = dist.candidates.filter(cand => cand.role === dist.roles[r].name && api.BigNumber(cand.weight).gt(dist.dustWeight));
        cands.sort((a, b) => api.BigNumber(b.weight).minus(a.weight));
        if (cands !== undefined && cands.length > 0) {
          const primaryCands = cands.length > dist.roles[r].primary ? cands.slice(0, dist.roles[r].primary) : cands;
          const backupCands = cands.length > dist.roles[r].primary ? cands.slice(dist.roles[r].primary) : [];

          // primary candidates recieve 80% of the allocation by even split, or 100% if there are no backups
          const primaryMultiplier = backupCands.length > 0 ? 80 : 100;
          for (let i = 0; i < primaryCands.length; i += 1) {
            const recipient = primaryCands[i].account;
            const recipientShare = api.BigNumber(rolePay)
              .multipliedBy(primaryMultiplier)
              .dividedBy(100)
              .dividedBy(primaryCands.length)
              .toFixed(stakeToken.precision);
            const tx = await api.transferTokens(recipient, symbol, recipientShare, 'user');
            api.assert(tx.errors === undefined, `unable to send ${recipientShare} ${symbol} to ${recipient}`);
          }

          // remaining candidates receive 20% proportionally by weight
          if (backupCands.length > 0) {
            const backupWeight = backupCands.reduce((prev, cur) => api.BigNumber(prev).plus(cur.weight), 0);
            for (let i = 0; i < backupCands.length; i += 1) {
              const recipient = backupCands[i].account;
              const recipientShareWeight = api.BigNumber(backupCands[i].weight).dividedBy(backupWeight);
              const recipientShare = api.BigNumber(rolePay)
                .multipliedBy(20)
                .dividedBy(100)
                .multipliedBy(recipientShareWeight)
                .toFixed(stakeToken.precision);
              const tx = await api.transferTokens(recipient, symbol, recipientShare, 'user');
              api.assert(tx.errors === undefined, `unable to send ${recipientShare} ${symbol} to ${recipient}`);
            }
          }
          api.emit('deposit', `Distributed role ${dist.roles[r].name}`);
        } else {
          api.emit('deposit', `No candidates to pay for role ${dist.roles[r].name}`);
        }
      }
    }
  }
};
