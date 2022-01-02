/* eslint-disable max-len */
/* eslint-disable no-underscore-dangle */
/* eslint-disable no-await-in-loop */
/* global actions, api */

const ContractName = 'roles';
const FeeMethod = ['burn', 'issuer'];

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('instances');
  if (tableExists === false) {
    await api.db.createTable('instances', ['id', 'lastTickTime']);
    await api.db.createTable('roles', [
      'instanceId',
      { name: 'byLastTickTime', index: { instanceId: 1, active: 1, lastTickTime: 1 } },
    ]);
    await api.db.createTable('candidates', [
      'account',
      { name: 'byAccountRole', index: { roleId: 1, account: 1 } },
      { name: 'byApprovalWeight', index: { roleId: 1, approvalWeight: 1, active: 1 } },
    ]);
    await api.db.createTable('approvals', ['from', 'to']);
    await api.db.createTable('accounts', [], { primaryKey: ['account'] });
    await api.db.createTable('params');

    const params = {};
    params.instanceCreationFee = '500';
    params.instanceUpdateFee = '100';
    params.instanceTickHours = '24';
    params.roleCreationFee = '50';
    params.roleUpdateFee = '25';
    params.maxSlots = 10;
    params.maxInstancesPerBlock = 1;
    params.maxRolesPerBlock = 4;
    params.maxAccountApprovals = 50;
    params.processQueryLimit = 1000;
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  const {
    instanceCreationFee,
    instanceUpdateFee,
    instanceTickHours,
    roleCreationFee,
    roleUpdateFee,
    maxSlots,
    maxInstancesPerBlock,
    maxRolesPerBlock,
    maxAccountApprovals,
    processQueryLimit,
  } = payload;

  if (api.sender !== api.owner) return;
  const params = await api.db.findOne('params', {});
  if (instanceCreationFee) {
    if (!api.assert(typeof instanceCreationFee === 'string' && !api.BigNumber(instanceCreationFee).isNaN() && api.BigNumber(instanceCreationFee).gte(0), 'invalid instanceCreationFee')) return;
    params.instanceCreationFee = instanceCreationFee;
  }
  if (instanceUpdateFee) {
    if (!api.assert(typeof instanceUpdateFee === 'string' && !api.BigNumber(instanceUpdateFee).isNaN() && api.BigNumber(instanceUpdateFee).gte(0), 'invalid instanceUpdateFee')) return;
    params.instanceUpdateFee = instanceUpdateFee;
  }
  if (instanceTickHours) {
    if (!api.assert(typeof instanceTickHours === 'string' && api.BigNumber(instanceTickHours).isInteger() && api.BigNumber(instanceTickHours).gte(1), 'invalid instanceTickHours')) return;
    params.instanceTickHours = instanceTickHours;
  }
  if (roleCreationFee) {
    if (!api.assert(typeof roleCreationFee === 'string' && !api.BigNumber(roleCreationFee).isNaN() && api.BigNumber(roleCreationFee).gte(0), 'invalid roleCreationFee')) return;
    params.roleCreationFee = roleCreationFee;
  }
  if (roleUpdateFee) {
    if (!api.assert(typeof roleUpdateFee === 'string' && !api.BigNumber(roleUpdateFee).isNaN() && api.BigNumber(roleUpdateFee).gte(0), 'invalid roleUpdateFee')) return;
    params.roleUpdateFee = roleUpdateFee;
  }
  if (maxSlots) {
    if (!api.assert(typeof maxSlots === 'string' && api.BigNumber(maxSlots).isInteger() && api.BigNumber(maxSlots).gte(1), 'invalid maxSlots')) return;
    params.maxSlots = api.BigNumber(maxSlots).toNumber();
  }
  if (maxInstancesPerBlock) {
    if (!api.assert(typeof maxInstancesPerBlock === 'string' && api.BigNumber(maxInstancesPerBlock).isInteger() && api.BigNumber(maxInstancesPerBlock).gte(1), 'invalid maxInstancesPerBlock')) return;
    params.maxInstancesPerBlock = api.BigNumber(maxInstancesPerBlock).toNumber();
  }
  if (maxRolesPerBlock) {
    if (!api.assert(typeof maxRolesPerBlock === 'string' && api.BigNumber(maxRolesPerBlock).isInteger() && api.BigNumber(maxRolesPerBlock).gte(1), 'invalid maxRolesPerBlock')) return;
    params.maxRolesPerBlock = api.BigNumber(maxRolesPerBlock).toNumber();
  }
  if (maxAccountApprovals) {
    if (!api.assert(typeof maxAccountApprovals === 'string' && api.BigNumber(maxAccountApprovals).isInteger() && api.BigNumber(maxAccountApprovals).gte(1), 'invalid maxAccountApprovals')) return;
    params.maxAccountApprovals = api.BigNumber(maxAccountApprovals).toNumber();
  }
  if (processQueryLimit) {
    if (!api.assert(typeof processQueryLimit === 'string' && api.BigNumber(processQueryLimit).isInteger() && api.BigNumber(processQueryLimit).gte(1), 'invalid processQueryLimit')) return;
    params.processQueryLimit = api.BigNumber(processQueryLimit).toNumber();
  }
  await api.db.update('params', params);
};

async function updateCandidateWeight(id, deltaApprovalWeight, deltaToken = null) {
  const candidate = await api.db.findOne('candidates', { _id: id });
  if (candidate) {
    if (deltaToken) {
      const role = await api.db.findOne('roles', { _id: candidate.roleId });
      const inst = await api.db.findOne('instances', { _id: role.instanceId });
      if (inst.voteToken !== deltaToken.symbol) return true;
    }
    candidate.approvalWeight = {
      $numberDecimal: api.BigNumber(candidate.approvalWeight.$numberDecimal)
        .plus(deltaApprovalWeight),
    };
    await api.db.update('candidates', candidate);

    const role = await api.db.findOne('roles', { _id: candidate.roleId });
    role.totalApprovalWeight = {
      $numberDecimal: api.BigNumber(role.totalApprovalWeight.$numberDecimal)
        .plus(deltaApprovalWeight),
    };
    await api.db.update('roles', role);

    return true;
  }
  return false;
}

actions.createInstance = async (payload) => {
  const {
    voteToken, candidateFee, isSignedWithActiveKey,
  } = payload;

  const params = await api.db.findOne('params', {});
  const { instanceCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(instanceCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(instanceCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    if (candidateFee) {
      if (!api.assert(typeof candidateFee === 'object'
        && typeof candidateFee.method === 'string'
        && FeeMethod.indexOf(candidateFee.method) !== -1
        && typeof candidateFee.symbol === 'string'
        && typeof candidateFee.amount === 'string' && api.BigNumber(candidateFee.amount).gte(0), 'invalid candidateFee properties')) return;
      const feeTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: candidateFee.symbol });
      if (!api.assert(feeTokenObj && api.BigNumber(candidateFee.amount).dp() <= feeTokenObj.precision, 'invalid candidateFee token or precision')) return;
    }

    const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: voteToken });
    if (!api.assert(voteTokenObj && voteTokenObj.stakingEnabled, 'voteToken must have staking enabled')) return;

    const now = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const newInstance = {
      voteToken,
      candidateFee,
      active: false,
      creator: api.sender,
      lastTickTime: now.getTime(),
    };
    const insertedInst = await api.db.insert('instances', newInstance);

    if (api.sender !== api.owner
        && api.sender !== 'null'
        && api.BigNumber(instanceCreationFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: instanceCreationFee, isSignedWithActiveKey,
      });
    }
    api.emit('createInstance', { id: insertedInst._id });
  }
};

actions.updateInstance = async (payload) => {
  const {
    instanceId, candidateFee, isSignedWithActiveKey,
  } = payload;

  const params = await api.db.findOne('params', {});
  const { instanceUpdateFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedUpdate = api.BigNumber(instanceUpdateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(instanceUpdateFee);

  if (api.assert(authorizedUpdate, 'you must have enough tokens to cover the update fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(candidateFee, 'specify at least one field to update')) {
    const existingInst = await api.db.findOne('instances', { _id: instanceId });
    if (!api.assert(existingInst, 'instance not found')
      || !api.assert(existingInst.creator === api.sender || api.owner === api.sender, 'must be instance creator')) return;

    if (candidateFee) {
      if (!api.assert(typeof candidateFee === 'object'
        && typeof candidateFee.method === 'string'
        && FeeMethod.indexOf(candidateFee.method) !== -1
        && typeof candidateFee.symbol === 'string'
        && typeof candidateFee.amount === 'string' && api.BigNumber(candidateFee.amount).gte(0), 'invalid candidateFee object')) return;
      const feeTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: candidateFee.symbol });
      if (!api.assert(feeTokenObj && api.BigNumber(candidateFee.amount).dp() <= feeTokenObj.precision, 'invalid candidateFee token or precision')) return;
      existingInst.candidateFee = candidateFee;
    }

    await api.db.update('instances', existingInst);

    // burn the token update fees
    if (api.sender !== api.owner
        && api.sender !== 'null'
        && api.BigNumber(instanceUpdateFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: instanceUpdateFee, isSignedWithActiveKey,
      });
    }
    api.emit('updateInstance', { id: instanceId });
  }
};

actions.createRoles = async (payload) => {
  const {
    instanceId, roles, isSignedWithActiveKey,
  } = payload;

  const params = await api.db.findOne('params', {});
  const { roleCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(roleCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(roleCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(typeof roles === 'object' && Array.isArray(roles) && roles.length > 0 && roles.length <= 50, 'invalid roles object')) {
    const existingInst = await api.db.findOne('instances', { _id: instanceId });
    if (!api.assert(existingInst, 'instance not found')
      || !api.assert(existingInst.creator === api.sender || api.owner === api.sender, 'must be instance creator')) return;

    const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: existingInst.voteToken });
    for (let i = 0; i < roles.length; i += 1) {
      const role = roles[i];
      if (!api.assert(Object.keys(role).length === 5
        && typeof role.name === 'string' && role.name.length < 50
        && typeof role.voteThreshold === 'string' && api.BigNumber(role.voteThreshold).gte(0) && api.BigNumber(role.voteThreshold).dp() <= voteTokenObj.precision
        && typeof role.mainSlots === 'string' && api.BigNumber(role.mainSlots).isInteger() && api.BigNumber(role.mainSlots).gt(0) && api.BigNumber(role.mainSlots).lte(params.maxSlots)
        && typeof role.backupSlots === 'string' && api.BigNumber(role.backupSlots).isInteger() && api.BigNumber(role.backupSlots).gte(0) && api.BigNumber(role.backupSlots).lte(api.BigNumber(params.maxSlots).minus(role.mainSlots))
        && typeof role.tickHours === 'string' && api.BigNumber(role.tickHours).isInteger() && api.BigNumber(role.tickHours).gte(params.instanceTickHours) && api.BigNumber(role.tickHours).mod(params.instanceTickHours).eq(0), 'invalid roles properties')) return;
    }

    const insertedRoles = [];
    for (let i = 0; i < roles.length; i += 1) {
      const newRole = {
        instanceId: existingInst._id,
        ...roles[i],
        active: true,
        lastTickTime: 0,
        totalApprovalWeight: { $numberDecimal: '0' },
      };
      const insertedRole = await api.db.insert('roles', newRole);
      insertedRoles.push({ instanceId: insertedRole.instanceId, roleId: insertedRole._id, name: insertedRole.name });
    }

    if (api.sender !== api.owner
        && api.sender !== 'null'
        && api.BigNumber(roleCreationFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: roleCreationFee, isSignedWithActiveKey,
      });
    }
    api.emit('createRoles', { roles: insertedRoles });
  }
};

actions.updateRole = async (payload) => {
  const {
    roleId,
    active, name, voteThreshold,
    mainSlots, backupSlots, tickHours,
    isSignedWithActiveKey,
  } = payload;

  const params = await api.db.findOne('params', {});
  const { roleUpdateFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedUpdate = api.BigNumber(roleUpdateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(roleUpdateFee);

  if (api.assert(authorizedUpdate, 'you must have enough tokens to cover the update fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(typeof active !== 'undefined' || name || voteThreshold || mainSlots || backupSlots || tickHours, 'specify at least one field to update')) {
    const existingRole = await api.db.findOne('roles', { _id: roleId });
    const existingInst = await api.db.findOne('instances', { _id: existingRole.instanceId });
    if (!api.assert(existingRole, 'role not found') || !api.assert(existingInst, 'instance not found')
      || !api.assert(existingInst.creator === api.sender || api.owner === api.sender, 'must be instance creator')) return;

    if (active) {
      existingRole.active = !!active;
    }
    if (name) {
      if (!api.assert(typeof name === 'string' && name.length < 50, 'name must be a string less than 50 characters')) return;
      existingRole.name = name;
    }
    if (voteThreshold) {
      const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: existingInst.voteToken });
      if (!api.assert(typeof voteThreshold === 'string'
        && api.BigNumber(voteThreshold).gte(0)
        && api.BigNumber(voteThreshold).dp() <= voteTokenObj.precision, 'voteThreshold must be greater than or equal to 0, precision matching voteToken')) return;
      existingRole.voteThreshold = voteThreshold;
    }
    if (mainSlots) {
      if (!api.assert(typeof mainSlots === 'string'
        && api.BigNumber(mainSlots).isInteger()
        && api.BigNumber(mainSlots).gt(0)
        && api.BigNumber(mainSlots).lte(params.maxSlots), 'mainSlots must be a integer between 1 - params.maxSlots')) return;
      existingRole.mainSlots = mainSlots;
    }
    if (backupSlots) {
      const remainingSlots = api.BigNumber(params.maxSlots).minus(existingRole.mainSlots);
      if (!api.assert(typeof backupSlots === 'string'
        && api.BigNumber(backupSlots).isInteger()
        && api.BigNumber(backupSlots).gte(0)
        && api.BigNumber(backupSlots).lte(remainingSlots), 'backupSlots must be an integer between 0 - remainingSlots')) return;
      existingRole.backupSlots = backupSlots;
    }
    if (tickHours) {
      if (!api.assert(typeof tickHours === 'string'
        && api.BigNumber(tickHours).isInteger()
        && api.BigNumber(tickHours).gte(params.instanceTickHours)
        && api.BigNumber(tickHours).mod(params.instanceTickHours).eq(0), 'tickHours must be an integer greater than or equal to, and a multiple of params.instanceTickHours')) return;
      existingRole.tickHours = tickHours;
    }

    await api.db.update('roles', existingRole);

    // burn the token update fees
    if (api.sender !== api.owner
        && api.sender !== 'null'
        && api.BigNumber(roleUpdateFee).gt(0)) {
      await api.executeSmartContract('tokens', 'transfer', {
        // eslint-disable-next-line no-template-curly-in-string
        to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: roleUpdateFee, isSignedWithActiveKey,
      });
    }
    api.emit('updateRole', { id: existingRole._id });
  }
};

actions.setInstanceActive = async (payload) => {
  const {
    instanceId,
    active,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    return;
  }
  const inst = await api.db.findOne('instances', { _id: instanceId });
  if (api.assert(inst, 'instance does not exist')
    && api.assert(inst.creator === api.sender || api.owner === api.sender, 'must be instance creator')) {
    inst.active = !!active;
    await api.db.update('instances', inst);
    api.emit('setInstanceActive', { id: inst.id, active: inst.active });
  }
};

actions.applyForRole = async (payload) => {
  const {
    roleId,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && !api.assert(typeof roleId === 'string', 'invalid roleId')) {
    return;
  }
  const role = await api.db.findOne('roles', { _id: api.BigNumber(roleId).toNumber() });
  if (!api.assert(role, 'role does not exist')) return;
  const inst = await api.db.findOne('instances', { _id: role.instanceId });

  let authorizedCreation = true;
  if (inst.candidateFee) {
    const feeTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: inst.candidateFee.symbol });
    authorizedCreation = api.BigNumber(inst.candidateFee.amount).lte(0) || api.sender === api.owner
      ? true
      : feeTokenBalance && api.BigNumber(feeTokenBalance.balance).gte(inst.candidateFee.amount);
  }

  const existingApply = await api.db.findOne('candidates', { roleId: role._id, account: api.sender });
  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the application fee')
    && api.assert(!existingApply, 'sender already applied for role')) {
    const newCandidate = {
      roleId: role._id,
      account: api.sender,
      active: true,
      approvalWeight: { $numberDecimal: '0' },
    };
    const insertedId = await api.db.insert('candidates', newCandidate);

    if (api.sender !== api.owner && inst.candidateFee) {
      if (inst.candidateFee.method === 'burn') {
        await api.executeSmartContract('tokens', 'transfer', {
          to: 'null', symbol: inst.candidateFee.symbol, quantity: inst.candidateFee.amount,
        });
      } else if (inst.candidateFee.method === 'issuer') {
        const feeTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: inst.candidateFee.symbol });
        await api.executeSmartContract('tokens', 'transfer', {
          to: feeTokenObj.issuer, symbol: inst.candidateFee.symbol, quantity: inst.candidateFee.amount,
        });
      }
    }

    api.emit('applyForRole', { roleId: role._id, candidateId: insertedId._id });
  }
};

actions.toggleApplyForRole = async (payload) => {
  const {
    roleId,
    active,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && !api.assert(typeof roleId === 'string', 'invalid roleId')
    && !api.assert(typeof active === 'string', 'invalid active')) {
    return;
  }
  const role = await api.db.findOne('roles', { _id: api.BigNumber(roleId).toNumber() });
  const existingApply = await api.db.findOne('candidates', { roleId: role._id, account: api.sender });
  if (api.assert(role, 'role does not exist')
    && api.assert(existingApply, 'candidate does not exist for sender')) {
    existingApply.active = !!active;
    await api.db.update('candidates', existingApply);
    api.emit('toggleApplyForRole', { roleId: role._id, account: existingApply.account, active });
  }
};

// deposit

async function updateTokenBalances(role, token, quantity) {
  const upRole = role;
  if (upRole.tokenBalances) {
    const tIndex = upRole.tokenBalances.findIndex(t => t.symbol === token.symbol);
    if (tIndex === -1) {
      upRole.tokenBalances.push({ symbol: token.symbol, quantity });
    } else {
      upRole.tokenBalances[tIndex].quantity = api.BigNumber(upRole.tokenBalances[tIndex].quantity)
        .plus(quantity)
        .toFixed(token.precision, api.BigNumber.ROUND_DOWN);
    }
  } else {
    upRole.tokenBalances = [
      { symbol: token.symbol, quantity },
    ];
  }
  await api.db.update('roles', upRole);
}

actions.deposit = async (payload) => {
  const {
    roleId, symbol, quantity,
    isSignedWithActiveKey,
  } = payload;

  const depToken = await api.db.findOneInTable('tokens', 'tokens', { symbol });
  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    || !api.assert(typeof quantity === 'string' && api.BigNumber(quantity).gt(0), 'invalid quantity')
    || !api.assert(api.BigNumber(quantity).dp() <= depToken.precision, 'quantity precision mismatch')) {
    return;
  }

  const role = await api.db.findOne('roles', { _id: roleId });
  if (api.assert(role, 'role not found') && api.assert(role.active, 'role must be active to deposit')) {
    const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: ContractName });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === ContractName && el.data.quantity === quantity) !== undefined) {
      await updateTokenBalances(role, depToken, quantity);
      api.emit('deposit', {
        roleId,
        symbol,
        quantity,
      });
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
    && 'roleId' in data && typeof data.roleId === 'string'
    && api.BigNumber(data.roleId).isInteger(), 'invalid incoming payload')) return;

  const role = await api.db.findOne('roles', { _id: api.BigNumber(data.roleId).toNumber() });
  if (api.assert(role, 'role not found') && api.assert(role.active, 'role must be active to deposit')) {
    const depToken = await api.db.findOneInTable('tokens', 'tokens', { symbol });
    await updateTokenBalances(role, depToken, quantity);
    api.emit('receiveDtfTokens', {
      roleId: data.roleId,
      symbol,
      quantity,
    });
  }
};

actions.receiveDistTokens = async (payload) => {
  const {
    data, symbol, quantity,
    callingContractInfo,
  } = payload;

  if (!api.assert(callingContractInfo && callingContractInfo.name === 'distribution', 'not authorized')) return;
  if (!api.assert(typeof data === 'object'
    && data.constructor.name === 'Object'
    && 'roleId' in data && typeof data.roleId === 'string'
    && api.BigNumber(data.roleId).isInteger(), 'invalid incoming payload')) return;

  const role = await api.db.findOne('roles', { _id: api.BigNumber(data.roleId).toNumber() });
  if (api.assert(role, 'role not found') && api.assert(role.active, 'role must be active to deposit')) {
    const depToken = await api.db.findOneInTable('tokens', 'tokens', { symbol });
    await updateTokenBalances(role, depToken, quantity);
    api.emit('receiveDistTokens', {
      roleId: data.roleId,
      symbol,
      quantity,
    });
  }
};

// voting

actions.approveCandidate = async (payload) => {
  const { id } = payload;
  const params = await api.db.findOne('params', {});

  if (api.assert(typeof id === 'string' && api.BigNumber(id).isInteger(), 'invalid id')) {
    const candidate = await api.db.findOne('candidates', { _id: api.BigNumber(id).toNumber() });

    if (api.assert(candidate, 'candidate does not exist')
      && api.assert(candidate.active, 'candidate is not active')) {
      const role = await api.db.findOne('roles', { _id: candidate.roleId });
      if (!api.assert(role.active, 'role must be active to approve')) return;

      const inst = await api.db.findOne('instances', { _id: role.instanceId });
      const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: inst.voteToken });
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
        { from: api.sender, candidatePending: true },
        params.maxAccountApprovals,
        0,
        [{ index: '_id', descending: true }]);
      for (let index = 0; index < approvals.length; index += 1) {
        const approval = approvals[index];
        const approvalCandidate = await api.db.findOne('candidates', { _id: approval.to });
        if (approvalCandidate && approvalCandidate.active) {
          activeApprovals += 1;
        } else {
          approval.candidatePending = false;
          await api.db.update('approvals', approval);
        }
      }
      if (!api.assert(activeApprovals < params.maxAccountApprovals, `you can only approve ${params.maxAccountApprovals} active candidates`)) return;

      let approval = await api.db.findOne('approvals', { from: api.sender, to: candidate._id });
      if (api.assert(approval === null, 'you already approved this candidate')) {
        approval = {
          from: api.sender,
          to: candidate._id,
          candidatePending: true,
        };
        await api.db.insert('approvals', approval);

        const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: inst.voteToken });
        let approvalWeight = 0;
        if (balance && balance.stake) {
          approvalWeight = balance.stake;
        }
        if (balance && balance.delegationsIn) {
          approvalWeight = api.BigNumber(approvalWeight)
            .plus(balance.delegationsIn)
            .toFixed(voteTokenObj.precision, api.BigNumber.ROUND_HALF_UP);
        }
        const wIndex = acct.weights.findIndex(x => x.symbol === inst.voteToken);
        if (wIndex !== -1) {
          acct.weights[wIndex].weight = approvalWeight;
        } else {
          acct.weights.push({ symbol: inst.voteToken, weight: approvalWeight });
        }
        await api.db.update('accounts', acct);
        await updateCandidateWeight(candidate._id, approvalWeight);
        api.emit('approveCandidate', { id: candidate._id });
      }
    }
  }
};

actions.disapproveCandidate = async (payload) => {
  const { id } = payload;

  if (api.assert(typeof id === 'string' && api.BigNumber(id).isInteger(), 'invalid id')) {
    const candidate = await api.db.findOne('candidates', { _id: api.BigNumber(id).toNumber() });
    if (api.assert(candidate, 'candidate does not exist')) {
      const inst = await api.db.findOne('instances', { id: candidate.instanceId });
      const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: inst.voteToken });
      let acct = await api.db.findOne('accounts', { account: api.sender });
      if (acct === null) {
        acct = {
          account: api.sender,
          weights: [],
        };
        acct = await api.db.insert('accounts', acct);
      }

      const approval = await api.db.findOne('approvals', { from: api.sender, to: candidate._id });
      if (api.assert(approval !== null, 'you have not approved this candidate')) {
        await api.db.remove('approvals', approval);

        const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: inst.voteToken });
        let approvalWeight = 0;
        if (balance && balance.stake) {
          approvalWeight = balance.stake;
        }
        if (balance && balance.delegationsIn) {
          approvalWeight = api.BigNumber(approvalWeight)
            .plus(balance.delegationsIn)
            .toFixed(voteTokenObj.precision, api.BigNumber.ROUND_HALF_UP);
        }
        const wIndex = acct.weights.findIndex(x => x.symbol === inst.voteToken);
        if (wIndex !== -1) {
          acct.weights[wIndex].weight = approvalWeight;
        } else {
          acct.weights.push({ symbol: inst.voteToken, weight: approvalWeight });
        }
        await api.db.update('accounts', acct);
        await updateCandidateWeight(candidate._id, api.BigNumber(approvalWeight).negated());
        api.emit('disapproveCandidate', { id: candidate._id });
      }
    }
  }
};

actions.updateCandidateApprovals = async (payload) => {
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
          { from: account, candidatePending: true },
          params.maxAccountApprovals,
          0,
          [{ index: '_id', descending: true }]);
        for (let index = 0; index < approvals.length; index += 1) {
          const approval = approvals[index];
          const candidatePending = await updateCandidateWeight(approval.to,
            deltaApprovalWeight,
            token);
          if (!candidatePending) {
            approval.candidatePending = false;
            await api.db.update('approvals', approval);
          }
        }
      }
    }
  }
};

// ticks

async function payRecipient(account, symbol, quantity, type = 'user', contractPayload = null) {
  if (api.BigNumber(quantity).gt(0)) {
    const res = await api.transferTokens(account, symbol, quantity, type);
    if (type === 'contract' && contractPayload) {
      await api.executeSmartContract(account, 'receiveRolesTokens',
        { data: contractPayload, symbol, quantity });
    }
    if (res.errors) {
      api.debug(`Error paying out roles of ${quantity} ${symbol} to ${account} (TXID ${api.transactionId}): \n${res.errors}`);
      return false;
    }
    return true;
  }
  return false;
}

async function checkPendingCandidates(inst, params) {
  const random = api.random();
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const upInst = JSON.parse(JSON.stringify(inst));
  const voteTokenObj = await api.db.findOneInTable('tokens', 'tokens', { symbol: inst.voteToken });
  const voteTokenMinValue = api.BigNumber(1)
    .dividedBy(api.BigNumber(10).pow(voteTokenObj.precision));
  const instTickTime = api.BigNumber(blockDate.getTime())
    .minus(params.instanceTickHours * 3600 * 1000).toNumber();

  let rolesProcessed = 0;
  const pendingRoles = await api.db.find('roles',
    {
      instanceId: inst.id,
      active: true,
      'tokenBalances.0': { $exists: true },
      lastTickTime: { $lte: instTickTime },
    },
    params.maxRolesPerBlock,
    0,
    [{ index: 'byLastTickTime', descending: false }, { index: '_id', descending: false }]);

  for (let i = 0; i < pendingRoles.length; i += 1) {
    const role = pendingRoles[i];
    const funded = [];
    const payTokens = role.tokenBalances.filter(t => api.BigNumber(t.quantity).gt(0));
    const totalSlots = api.BigNumber(role.mainSlots).plus(role.backupSlots).toNumber();
    const roleTickTime = api.BigNumber(blockDate.getTime())
      .minus(role.tickHours * 3600 * 1000).toNumber();

    if (role.lastTickTime <= roleTickTime) {
      if (payTokens.length > 0) {
        let offset = 0;
        let candidates = await api.db.find('candidates',
          {
            roleId: role._id,
            active: true,
            approvalWeight: { $gt: { $numberDecimal: api.BigNumber(role.voteThreshold) } },
          },
          params.processQueryLimit,
          offset,
          [{ index: 'byApprovalWeight', descending: true }, { index: '_id', descending: false }]);

        let accWeight = 0;
        let backupWeight = null;
        do {
          for (let j = 0; j < candidates.length; j += 1) {
            const candidate = candidates[j];
            if (funded.length >= role.mainSlots && backupWeight === null) {
              backupWeight = api.BigNumber(accWeight)
                .plus(voteTokenMinValue)
                .plus(api.BigNumber(role.totalApprovalWeight.$numberDecimal)
                  .minus(accWeight)
                  .times(random))
                .toFixed(voteTokenObj.precision, api.BigNumber.ROUND_HALF_UP);
            }

            accWeight = api.BigNumber(accWeight)
              .plus(candidate.approvalWeight.$numberDecimal)
              .toFixed(voteTokenObj.precision, api.BigNumber.ROUND_HALF_UP);

            if (candidate.active === true) {
              if (funded.length < role.mainSlots || api.BigNumber(backupWeight).lte(accWeight)) {
                funded.push({
                  candidate: candidate._id,
                  account: candidate.account,
                });
              }
            }
            if (funded.length >= totalSlots) break;
          }

          if (funded.length < totalSlots) {
            offset += params.processQueryLimit;
            candidates = await api.db.find('candidates',
              {
                roleId: role._id,
                active: true,
                approvalWeight: { $gt: { $numberDecimal: api.BigNumber(role.voteThreshold) } },
              },
              params.processQueryLimit,
              offset,
              [{ index: 'byApprovalWeight', descending: true }, { index: '_id', descending: false }]);
          }
        } while (candidates.length > 0 && funded.length < totalSlots);

        for (let l = 0; l < payTokens.length; l += 1) {
          const payToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: payTokens[l].symbol });
          const payoutQty = api.BigNumber(payTokens[l].quantity)
            .dividedBy(totalSlots)
            .toFixed(payToken.precision, api.BigNumber.ROUND_DOWN);
          if (api.BigNumber(payoutQty).gt(0)) {
            for (let k = 0; k < funded.length; k += 1) {
              const fund = funded[k];
              const payResult = await payRecipient(fund.account, payTokens[l].symbol, payoutQty);
              if (payResult) {
                const tbIndex = role.tokenBalances.findIndex(b => b.symbol === payTokens[l].symbol);
                role.tokenBalances[tbIndex].quantity = api.BigNumber(role.tokenBalances[tbIndex].quantity)
                  .minus(payoutQty)
                  .toFixed(payToken.precision, api.BigNumber.ROUND_DOWN);
                api.emit('rolePayment', {
                  roleId: role._id,
                  account: fund.account,
                  symbol: payTokens[l].symbol,
                  quantity: payoutQty,
                });
              }
            }
          }
        }
      }
      rolesProcessed += 1;
      const upRole = JSON.parse(JSON.stringify(role));
      upRole.lastTickTime = blockDate.getTime();
      await api.db.update('roles', upRole);
    }
  }

  if (rolesProcessed === 0) {
    upInst.lastTickTime = blockDate.getTime();
    await api.db.update('instances', upInst);
  }
}

actions.checkPendingInstances = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const params = await api.db.findOne('params', {});
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const tickTime = api.BigNumber(blockDate.getTime())
      .minus(params.instanceTickHours * 3600 * 1000).toNumber();

    const pendingInst = await api.db.find('instances',
      {
        active: true,
        lastTickTime: {
          $lte: tickTime,
        },
      },
      params.maxInstancesPerBlock,
      0,
      [{ index: 'lastTickTime', descending: false }, { index: '_id', descending: false }]);

    for (let i = 0; i < pendingInst.length; i += 1) {
      await checkPendingCandidates(pendingInst[i], params);
    }
  }
};
