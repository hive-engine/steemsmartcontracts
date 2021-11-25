/* eslint-disable no-await-in-loop */
/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
/* global actions, api */

const MAX_DIGITS = 20;
const PROPERTY_OPS = {
  ADD: {
    add: (x, y) => api.BigNumber(x).plus(y),
    remove: (x, y) => api.BigNumber(x).minus(y),
    defaultValue: 0,
  },
  MULTIPLY: {
    add: (x, y) => api.BigNumber(x).multipliedBy(y).dp(MAX_DIGITS),
    remove: (x, y) => api.BigNumber(x).dividedBy(y).dp(MAX_DIGITS),
    defaultValue: 1,
  },
};
const MINING_POWER_FIELD_INDEX = '_miningPower';


actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('miningPower');
  if (tableExists === false) {
    await api.db.createTable('miningPower', ['id', 'power']);
    await api.db.createTable('pools', ['id']);
    // Given symbol, output which pools are using it.
    await api.db.createTable('tokenPools', ['symbol']);
    await api.db.createTable('nftTokenPools', ['symbol']);
    await api.db.createTable('params');

    const params = {};
    params.poolCreationFee = '1000';
    params.poolUpdateFee = '300';
    params.maxLotteriesPerBlock = 20;
    params.maxBalancesProcessedPerBlock = 10000;
    params.processQueryLimit = 1000;
    await api.db.insert('params', params);
  } else {
    const params = await api.db.findOne('params', {});
    if (!params.updateIndex) {
      // would want this to be a primary key, but cannot alter primary keys
      await api.db.addIndexes('miningPower', [{ name: 'byPoolIdAndAccount', index: { id: 1, account: 1 } }]);
      params.updateIndex = 1;
      await api.db.update('params', params);
    }
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    poolCreationFee,
    poolUpdateFee,
    maxLotteriesPerBlock,
    maxBalancesProcessedPerBlock,
    processQueryLimit,
  } = payload;

  const params = await api.db.findOne('params', {});

  if (poolCreationFee) {
    if (!api.assert(typeof poolCreationFee === 'string' && !api.BigNumber(poolCreationFee).isNaN() && api.BigNumber(poolCreationFee).gte(0), 'invalid poolCreationFee')) return;
    params.poolCreationFee = poolCreationFee;
  }
  if (poolUpdateFee) {
    if (!api.assert(typeof poolUpdateFee === 'string' && !api.BigNumber(poolUpdateFee).isNaN() && api.BigNumber(poolUpdateFee).gte(0), 'invalid poolUpdateFee')) return;
    params.poolUpdateFee = poolUpdateFee;
  }
  if (maxLotteriesPerBlock) {
    if (!api.assert(Number.isInteger(maxLotteriesPerBlock) && maxLotteriesPerBlock >= 1, 'invalid maxLotteriesPerBlock')) return;
    params.maxLotteriesPerBlock = maxLotteriesPerBlock;
  }
  if (maxBalancesProcessedPerBlock) {
    if (!api.assert(Number.isInteger(maxBalancesProcessedPerBlock) && maxBalancesProcessedPerBlock >= 1, 'invalid maxBalancesProcessedPerBlock')) return;
    params.maxBalancesProcessedPerBlock = maxBalancesProcessedPerBlock;
  }
  if (processQueryLimit) {
    if (!api.assert(Number.isInteger(processQueryLimit) && processQueryLimit >= 1, 'invalid processQueryLimit')) return;
    params.processQueryLimit = processQueryLimit;
  }

  await api.db.update('params', params);
};

const findAndProcessAll = async (contractName, table, query, callback) => {
  let offset = 0;
  let results = [];
  let done = false;
  while (!done) {
    results = await api.db.findInTable(contractName, table, query, 1000, offset);
    if (results) {
      for (let i = 0; i < results.length; i += 1) {
        await callback(results[i]);
      }
      if (results.length < 1000) {
        done = true;
      } else {
        offset += 1000;
      }
    }
  }
};

async function validateNftProperties(properties) {
  if (!api.assert(properties && Array.isArray(properties), 'invalid nftTokenMiner properties')) return false;
  if (!api.assert(properties.length > 0 && properties.length <= 4, 'nftTokenMiner properties size must be between 1 and 4')) return false;

  for (let i = 0; i < properties.length; i += 1) {
    const prop = properties[i];
    const propKeys = Object.keys(prop);
    for (let j = 0; j < propKeys.length; j += 1) {
      const propKey = propKeys[j];
      if (propKey === 'op') {
        if (!api.assert(typeof prop.op === 'string' && PROPERTY_OPS[prop.op], 'nftTokenMiner properties op should be ADD or MULTIPLY')) return false;
      } else if (propKey === 'name') {
        if (!api.assert(typeof prop.name === 'string' && prop.name.length <= 16, 'nftTokenMiner properties name should be a string of length <= 16')) return false;
      } else if (propKey === 'burnChange') {
        if (!api.assert(typeof prop.burnChange === 'object'
            && typeof prop.burnChange.symbol === 'string'
            && api.BigNumber(prop.burnChange.quantity).isFinite()
            && api.BigNumber(prop.burnChange.quantity).isPositive(), 'nftTokenMiner properties burnChange invalid')) return false;
        const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: prop.burnChange.symbol });
        if (!api.assert(token, 'nftTokenMiner properties burnChange symbol not found')) return false;
      } else {
        api.assert(false, 'nftTokenMiner properties field invalid');
        return false;
      }
    }
  }
  return true;
}

function validateNftTypeMap(typeMap, properties) {
  if (!api.assert(typeMap && typeof typeMap === 'object', 'invalid nftTokenMiner typeMap')) return false;
  const types = Object.keys(typeMap);
  for (let j = 0; j < types.length; j += 1) {
    const type = types[j];
    const typeConfig = typeMap[type];
    if (!api.assert(Array.isArray(typeConfig) && typeConfig.length === properties.length, 'nftTokenMiner typeConfig length mismatch')) return false;
    for (let k = 0; k < typeConfig.length; k += 1) {
      const typeProperty = api.BigNumber(typeConfig[k]);
      if (!api.assert(!typeProperty.isNaN() && typeProperty.isFinite(), 'nftTokenMiner typeConfig invalid')) return false;
      if (properties[k].op === 'MULTIPLY') {
        if (!api.assert(typeProperty.gte(0.01) && typeProperty.lte(100),
          'nftTokenMiner typeConfig MULTIPLY property should be between 0.01 and 100')) return false;
      }
    }
  }
  return true;
}

async function validateTokenMiners(tokenMiners, nftTokenMiner) {
  if (!api.assert(tokenMiners && Array.isArray(tokenMiners), 'tokenMiners invalid')) return false;
  if (!api.assert((tokenMiners.length >= 1 && tokenMiners.length <= 2)
      || (nftTokenMiner && tokenMiners.length === 0),
  'only 1 or 2 tokenMiners allowed')) return false;
  const tokenMinerSymbols = new Set();
  for (let i = 0; i < tokenMiners.length; i += 1) {
    const tokenMinerConfig = tokenMiners[i];
    if (!api.assert(tokenMinerConfig && tokenMinerConfig.symbol
      && typeof (tokenMinerConfig.symbol) === 'string', 'tokenMiners invalid')) return false;
    if (!api.assert(!tokenMinerSymbols.has(tokenMinerConfig.symbol), 'tokenMiners cannot have duplicate symbols')) return false;
    tokenMinerSymbols.add(tokenMinerConfig.symbol);
    const { symbol } = tokenMinerConfig;
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
    if (!api.assert(token && token.stakingEnabled, 'tokenMiners must have staking enabled')) return false;
    if (!api.assert(Number.isInteger(tokenMinerConfig.multiplier)
      && tokenMinerConfig.multiplier >= 1 && tokenMinerConfig.multiplier <= 100,
    'tokenMiner multiplier must be an integer from 1 to 100')) return false;
  }
  if (nftTokenMiner) {
    if (!api.assert(nftTokenMiner.symbol
        && typeof (nftTokenMiner.symbol) === 'string', 'nftTokenMiner invalid')) return false;
    const {
      symbol, typeMap, properties, typeField,
      equipField, miningPowerField,
    } = nftTokenMiner;
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
    if (!api.assert(nft && nft.delegationEnabled, 'nftTokenMiner must have delegation enabled')) return false;
    if (!api.assert(typeField && typeof typeField === 'string', 'typeField must be a string')) return false;
    if (!api.assert(nft.properties[typeField] && nft.properties[typeField].type === 'string', 'nftTokenMiner must have string type property')) return false;
    if (equipField !== undefined) {
      if (!api.assert(equipField && typeof equipField === 'string', 'equipField must be a string')) return false;
      if (!api.assert(nft.properties[equipField] && nft.properties[equipField].type === 'string', 'nftTokenMiner must have string equip property')) return false;
    }
    if (miningPowerField !== undefined) {
      if (!api.assert(miningPowerField && typeof miningPowerField === 'string', 'miningPowerField must be a string')) return false;
      if (!api.assert(nft.properties[miningPowerField] && nft.properties[miningPowerField].type === 'string', 'nftTokenMiner must have string miningPower property')) return false;
    }
    if (!(await validateNftProperties(properties))) return false;
    if (!validateNftTypeMap(typeMap, properties)) return false;
  }
  return true;
}

async function validateTokenMinersChange(oldTokenMiners, tokenMiners, oldNftTokenMiner,
  nftTokenMiner) {
  if (!api.assert(tokenMiners.length === oldTokenMiners.length, 'cannot change which tokens are in tokenMiners')) return false;
  let changed = false;
  for (let i = 0; i < tokenMiners.length; i += 1) {
    const oldConfig = oldTokenMiners[i];
    const newConfig = tokenMiners[i];
    if (!api.assert(oldConfig.symbol === newConfig.symbol, 'cannot change which tokens are in tokenMiners')) return false;
    if (!api.assert(Number.isInteger(newConfig.multiplier) && newConfig.multiplier >= 1 && newConfig.multiplier <= 100, 'tokenMiner multiplier must be an integer from 1 to 100')) return false;
    if (oldConfig.multiplier !== newConfig.multiplier) {
      changed = true;
    }
  }
  if (!api.assert(!!oldNftTokenMiner === !!nftTokenMiner, 'cannot change nftTokenMiner token')) return false;
  if (nftTokenMiner) {
    if (!api.assert(oldNftTokenMiner.symbol === nftTokenMiner.symbol, 'cannot change nftTokenMiner token')) return false;
    const {
      typeMap, properties, typeField, equipField, miningPowerField,
    } = nftTokenMiner;
    if (!api.assert(typeField && typeof typeField === 'string'
        && typeField === oldNftTokenMiner.typeField, 'cannot change nftTokenMiner typeField')) return false;
    if (oldNftTokenMiner.equipField) {
      if (!api.assert(equipField && typeof equipField === 'string'
          && equipField === oldNftTokenMiner.equipField, 'cannot change nftTokenMiner equipField')) return false;
    } else if (!api.assert(!equipField, 'cannot change nftTokenMiner equipField')) return false;
    if (oldNftTokenMiner.miningPowerField) {
      if (!api.assert(miningPowerField && typeof miningPowerField === 'string'
            && miningPowerField === oldNftTokenMiner.miningPowerField, 'cannot change nftTokenMiner miningPowerField')) return false;
    } else if (!api.assert(!miningPowerField, 'cannot change nftTokenMiner miningPowerField')) return false;
    if (!api.assert(typeMap && typeof typeMap === 'object', 'invalid nftTokenMiner typeMap')) return false;
    if (!(await validateNftProperties(properties))) return false;
    if (properties.length !== oldNftTokenMiner.properties.length) {
      changed = true;
    } else {
      for (let i = 0; i < properties.length; i += 1) {
        const prop = properties[i];
        const oldProp = oldNftTokenMiner.properties[i];
        if (prop.op !== oldProp.op) changed = true;
      }
    }
    if (!validateNftTypeMap(typeMap, properties)) return false;
    const oldTypes = Object.keys(oldNftTokenMiner.typeMap);
    for (let i = 0; i < oldTypes.length; i += 1) {
      const oldType = oldTypes[i];
      const oldTypeConfig = oldNftTokenMiner.typeMap[oldType];
      const typeConfig = typeMap[oldType];
      if (!api.assert(typeConfig, 'typeConfig types must be a superset of old typeConfig types')) return false;
      for (let j = 0; j < typeConfig.length; j += 1) {
        if (oldTypeConfig[j] !== typeConfig[j]) changed = true;
      }
    }
  }
  return { changed };
}

function computeMiningPower(miningPower, tokenMiners, nftTokenMiner) {
  let power = api.BigNumber(0);
  for (let i = 0; i < tokenMiners.length; i += 1) {
    if (miningPower.balances[i]) {
      power = power.plus(api.BigNumber(miningPower.balances[i])
        .multipliedBy(tokenMiners[i].multiplier));
    }
  }
  if (nftTokenMiner && miningPower.nftBalances) {
    let nftPower = api.BigNumber(1);
    // Note nftBalances is object type.
    for (let i = 0; i < nftTokenMiner.properties.length; i += 1) {
      nftPower = nftPower.multipliedBy(miningPower.nftBalances[i]).dp(MAX_DIGITS);
    }
    if (!nftPower.isFinite()) {
      nftPower = api.BigNumber(0);
    }
    if (miningPower.nftBalances[MINING_POWER_FIELD_INDEX]) {
      nftPower = nftPower.plus(miningPower.nftBalances[MINING_POWER_FIELD_INDEX]);
    }
    power = power.plus(nftPower);
  }
  if (power.isPositive() && power.isFinite()) {
    return power;
  }
  return api.BigNumber(0);
}

async function updateMiningPower(
  pool, token, account, stakedQuantity, delegatedQuantity, updatePoolTimestamp,
) {
  let miningPower = await api.db.findOne('miningPower', { id: pool.id, account });
  let stake = api.BigNumber(stakedQuantity);
  let oldMiningPower = api.BigNumber(0);
  stake = stake.plus(delegatedQuantity);
  const tokenIndex = pool.tokenMiners.findIndex(t => t.symbol === token);
  if (!miningPower) {
    const balances = {};
    balances[tokenIndex] = stake;
    miningPower = {
      id: pool.id,
      account,
      balances,
      power: { $numberDecimal: '0' },
    };
    miningPower = await api.db.insert('miningPower', miningPower);
  } else {
    if (updatePoolTimestamp && miningPower.updatePoolTimestamp !== updatePoolTimestamp) {
      // reset all balances
      for (let i = 0; i < pool.tokenMiners.length; i += 1) {
        miningPower.balances[i] = '0';
      }
      if (miningPower.nftBalances) {
        miningPower.nftBalances = {};
        const { nftBalances } = miningPower;
        for (let j = 0; j < pool.nftTokenMiner.properties.length; j += 1) {
          const property = pool.nftTokenMiner.properties[j];
          const opInfo = PROPERTY_OPS[property.op];
          nftBalances[j] = opInfo.defaultValue;
        }
      }
    } else if (!miningPower.balances[tokenIndex]) {
      miningPower.balances[tokenIndex] = '0';
    }
    oldMiningPower = computeMiningPower(miningPower, pool.tokenMiners, pool.nftTokenMiner);
    miningPower.balances[tokenIndex] = stake.plus(miningPower.balances[tokenIndex]);
  }
  const newMiningPower = computeMiningPower(miningPower, pool.tokenMiners, pool.nftTokenMiner);
  miningPower.power = { $numberDecimal: newMiningPower };
  if (updatePoolTimestamp) {
    miningPower.updatePoolTimestamp = updatePoolTimestamp;
  }
  await api.db.update('miningPower', miningPower);
  return newMiningPower.minus(oldMiningPower);
}

function getNftAccount(nft) {
  if (nft.delegatedTo.account === 'mining' && nft.delegatedTo.ownedBy === 'c') {
    return nft.account;
  } if (nft.delegatedTo.ownedBy === 'u') {
    return nft.delegatedTo.account;
  }
  return null;
}

function sanitizeNftMiningPower(nftMiningPower) {
  let extraNftMiningPower = api.BigNumber(nftMiningPower);
  if (extraNftMiningPower.isNaN() || !extraNftMiningPower.isFinite()) {
    extraNftMiningPower = api.BigNumber(0);
  }
  return extraNftMiningPower.dp(MAX_DIGITS);
}

/**
 * Params:
 *   - pool: reward pool object
 *   - nft: nft instance
 *   - add: whether to add or remove the nft
 *   - updatePoolTimestamp: controls whether to reset the mining power (during a new update request)
 *   - accountOverride: optional override, used for equipField pools
 */
async function updateNftMiningPower(pool, nft, add, updatePoolTimestamp, accountOverride) {
  const account = accountOverride || getNftAccount(nft);

  if (!account) return api.BigNumber(0);

  let miningPower = await api.db.findOne('miningPower', { id: pool.id, account });
  let oldMiningPower = api.BigNumber(0);
  let extraNftMiningPower = api.BigNumber(0);
  const {
    typeMap,
    properties,
    typeField,
    equipField,
    miningPowerField,
  } = pool.nftTokenMiner;

  const nftType = nft.properties[typeField];
  const typeProperties = typeMap[nftType];
  if (miningPowerField) {
    extraNftMiningPower = sanitizeNftMiningPower(nft.properties[miningPowerField]);
  }
  if (!miningPower) {
    const nftBalances = {};
    const equippedNft = { type: nftType };

    if (typeProperties) {
      for (let i = 0; i < properties.length; i += 1) {
        const property = properties[i];
        const opInfo = PROPERTY_OPS[property.op];
        if (add) {
          nftBalances[i] = opInfo.add(opInfo.defaultValue, typeProperties[i]);
        } else {
          api.assert(false, 'unexpected condition: remove without previous miningPower');
          return api.BigNumber(0);
        }
      }
    }
    if (miningPowerField) {
      nftBalances[MINING_POWER_FIELD_INDEX] = extraNftMiningPower;
      equippedNft.extraMiningPower = extraNftMiningPower;
    }
    const equippedNfts = {};
    equippedNfts[nft._id] = equippedNft;
    miningPower = {
      id: pool.id,
      account,
      balances: {},
      nftBalances,
      power: { $numberDecimal: '0' },
      equippedNfts,
    };
    miningPower = await api.db.insert('miningPower', miningPower);
  } else {
    if (!miningPower.nftBalances) {
      miningPower.nftBalances = {};
    }
    if (!miningPower.equippedNfts) {
      miningPower.equippedNfts = {};
    }
    const oldExtraNftMiningPower = 0;
    let equippedNft = miningPower.equippedNfts[nft._id];
    if (!equippedNft) {
      // If using equip field, verify already tracked in equippedNfts
      // This condition can happen if an NFT is issued with equip field populated up front.
      if (equipField && !add) {
        return api.BigNumber(0);
      }

      equippedNft = { type: nftType };
      miningPower.equippedNfts[nft._id] = equippedNft;
    }
    const { nftBalances } = miningPower;
    if (typeProperties) {
      for (let i = 0; i < properties.length; i += 1) {
        const property = properties[i];
        const opInfo = PROPERTY_OPS[property.op];
        if (!nftBalances[i] || miningPower.updatePoolTimestamp !== updatePoolTimestamp) {
          nftBalances[i] = opInfo.defaultValue;
        }
      }
    }
    if (miningPowerField && miningPower.updatePoolTimestamp !== updatePoolTimestamp) {
      nftBalances[MINING_POWER_FIELD_INDEX] = api.BigNumber(0);
    }
    oldMiningPower = computeMiningPower(miningPower, pool.tokenMiners, pool.nftTokenMiner);
    if (typeProperties) {
      for (let i = 0; i < properties.length; i += 1) {
        const property = properties[i];
        const opInfo = PROPERTY_OPS[property.op];
        if (add) {
          nftBalances[i] = opInfo.add(nftBalances[i], typeProperties[i]);
        } else {
          nftBalances[i] = opInfo.remove(nftBalances[i], typeProperties[i]);
        }
      }
    }
    if (miningPowerField) {
      if (!nftBalances[MINING_POWER_FIELD_INDEX]) {
        nftBalances[MINING_POWER_FIELD_INDEX] = api.BigNumber(0);
      }
      if (add) {
        equippedNft.extraMiningPower = extraNftMiningPower;
        nftBalances[MINING_POWER_FIELD_INDEX] = api.BigNumber(nftBalances[MINING_POWER_FIELD_INDEX])
          .minus(oldExtraNftMiningPower)
          .plus(extraNftMiningPower);
      } else {
        nftBalances[MINING_POWER_FIELD_INDEX] = api.BigNumber(nftBalances[MINING_POWER_FIELD_INDEX])
          .minus(extraNftMiningPower);
      }
    }
  }
  const newMiningPower = computeMiningPower(miningPower, pool.tokenMiners, pool.nftTokenMiner);
  miningPower.power = { $numberDecimal: newMiningPower };
  miningPower.updatePoolTimestamp = updatePoolTimestamp;
  if (!add) {
    delete miningPower.equippedNfts[nft._id];
  }
  await api.db.update('miningPower', miningPower);

  return newMiningPower.minus(oldMiningPower);
}

async function updateNftMiningPowerFromPropertyUpdate(pool, nft, accountOverride) {
  const account = accountOverride || getNftAccount(nft);

  if (!account) return api.BigNumber(0);

  let miningPower = await api.db.findOne('miningPower', { id: pool.id, account });
  let oldMiningPower = api.BigNumber(0);
  let extraNftMiningPower = api.BigNumber(0);
  const {
    typeField,
    equipField,
    miningPowerField,
  } = pool.nftTokenMiner;

  const nftType = nft.properties[typeField];
  if (miningPowerField) {
    extraNftMiningPower = sanitizeNftMiningPower(nft.properties[miningPowerField]);
  } else {
    return api.BigNumber(0);
  }
  if (!miningPower) {
    const nftBalances = {};
    const equippedNft = { type: nftType };

    nftBalances[MINING_POWER_FIELD_INDEX] = extraNftMiningPower;
    equippedNft.extraMiningPower = extraNftMiningPower;
    const equippedNfts = {};
    equippedNfts[nft._id] = equippedNft;
    miningPower = {
      id: pool.id,
      account,
      balances: {},
      nftBalances,
      power: { $numberDecimal: '0' },
      equippedNfts,
    };
    miningPower = await api.db.insert('miningPower', miningPower);
  } else {
    if (!miningPower.nftBalances) {
      miningPower.nftBalances = {};
    }
    if (!miningPower.equippedNfts) {
      miningPower.equippedNfts = {};
    }
    let oldExtraNftMiningPower = 0;
    let equippedNft = miningPower.equippedNfts[nft._id];
    if (!equippedNft) {
      // If using equip field, verify already tracked in equippedNfts
      // This condition can happen if an NFT is issued with equip field populated up front.
      if (equipField) {
        return api.BigNumber(0);
      }

      equippedNft = { type: nftType };
      miningPower.equippedNfts[nft._id] = equippedNft;
    } else {
      oldExtraNftMiningPower = equippedNft.extraMiningPower;
    }
    const { nftBalances } = miningPower;
    oldMiningPower = computeMiningPower(miningPower, pool.tokenMiners, pool.nftTokenMiner);
    if (!nftBalances[MINING_POWER_FIELD_INDEX]) {
      nftBalances[MINING_POWER_FIELD_INDEX] = api.BigNumber(0);
    }
    equippedNft.extraMiningPower = extraNftMiningPower;
    nftBalances[MINING_POWER_FIELD_INDEX] = api.BigNumber(nftBalances[MINING_POWER_FIELD_INDEX])
      .minus(oldExtraNftMiningPower)
      .plus(extraNftMiningPower);
  }
  const newMiningPower = computeMiningPower(miningPower, pool.tokenMiners, pool.nftTokenMiner);
  miningPower.power = { $numberDecimal: newMiningPower };
  await api.db.update('miningPower', miningPower);

  return newMiningPower.minus(oldMiningPower);
}

async function initMiningPower(pool, updatePoolTimestamp, params, token, lastId) {
  let adjustedPower = api.BigNumber(0);
  let offset = 0;
  let lastIdProcessed = lastId;
  let complete = false;
  let balances;
  while (!complete && offset < params.maxBalancesProcessedPerBlock) {
    balances = await api.db.findInTable('tokens', 'balances', { symbol: token, _id: { $gt: lastId } }, params.processQueryLimit, offset, [{ index: '_id', descending: false }]);
    for (let i = 0; i < balances.length; i += 1) {
      const balance = balances[i];
      if (api.BigNumber(balance.stake).gt(0) || api.BigNumber(balance.delegationsIn).gt(0)) {
        const adjusted = await updateMiningPower(
          pool, token, balance.account, balance.stake, balance.delegationsIn, updatePoolTimestamp,
        );
        adjustedPower = adjustedPower.plus(adjusted);
      }
      lastIdProcessed = balance._id;
    }
    if (balances.length < params.processQueryLimit) {
      complete = true;
    }
    offset += params.processQueryLimit;
  }
  return { adjustedPower, nextId: lastIdProcessed, complete };
}

async function initNftMiningPower(pool, updatePoolTimestamp, params, nftTokenMiner, lastId) {
  let adjustedPower = api.BigNumber(0);
  let offset = 0;
  let lastIdProcessed = lastId;
  let complete = false;
  let nfts;
  const {
    symbol,
    equipField,
  } = nftTokenMiner;
  while (!complete && offset < params.maxBalancesProcessedPerBlock) {
    const nftQuery = {
      _id: { $gt: lastId },
    };
    if (equipField) {
      nftQuery[`properties.${equipField}`] = { $exists: true, $ne: '' };
    } else {
      nftQuery.delegatedTo = { $ne: null };
      nftQuery['delegatedTo.undelegateAt'] = { $eq: null };
    }
    nfts = await api.db.findInTable('nft', `${symbol}instances`, nftQuery, params.processQueryLimit, offset, [{ index: '_id', descending: false }]);
    for (let i = 0; i < nfts.length; i += 1) {
      const nft = nfts[i];
      if (!equipField || nft.properties[equipField]) {
        const adjusted = await updateNftMiningPower(
          pool,
          nft,
          /* add */ true,
          updatePoolTimestamp,
          equipField ? nft.properties[equipField] : null,
        );
        adjustedPower = adjustedPower.plus(adjusted);
      }
      lastIdProcessed = nft._id;
    }
    if (nfts.length < params.processQueryLimit) {
      complete = true;
    }
    offset += params.processQueryLimit;
  }
  return { adjustedPower, nextId: lastIdProcessed, complete };
}

async function resumePowerUpdate(pool, params) {
  let {
    inProgress, tokenIndex, nftTokenIndex, lastId,
  } = pool.updating;
  const { updatePoolTimestamp } = pool.updating;
  if (!inProgress) {
    return;
  }

  if (tokenIndex < pool.tokenMiners.length) {
    const tokenConfig = pool.tokenMiners[tokenIndex];
    const { adjustedPower, nextId, complete } = await initMiningPower(
      pool, updatePoolTimestamp, params, tokenConfig.symbol, lastId,
    );
    // eslint-disable-next-line no-param-reassign
    pool.totalPower = api.BigNumber(pool.totalPower)
      .plus(adjustedPower);
    if (complete) {
      lastId = 0;
      tokenIndex += 1;
    } else {
      lastId = nextId;
    }
  } else if (pool.nftTokenMiner && nftTokenIndex < 1) {
    const { nftTokenMiner } = pool;
    const { adjustedPower, nextId, complete } = await initNftMiningPower(
      pool, updatePoolTimestamp, params, nftTokenMiner, lastId,
    );
    // eslint-disable-next-line no-param-reassign
    pool.totalPower = api.BigNumber(pool.totalPower)
      .plus(adjustedPower);
    if (complete) {
      lastId = 0;
      nftTokenIndex += 1;
    } else {
      lastId = nextId;
    }
  }

  if (tokenIndex === pool.tokenMiners.length
      && (!pool.nftTokenMiner || nftTokenIndex === 1)) {
    inProgress = false;
    tokenIndex = 0;
    nftTokenIndex = 0;
  }

  const { updating } = pool;
  updating.inProgress = inProgress;
  updating.tokenIndex = tokenIndex;
  updating.nftTokenIndex = nftTokenIndex;
  updating.lastId = lastId;
  await api.db.update('pools', pool);
}

actions.setActive = async (payload) => {
  const {
    id,
    active,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) {
    return;
  }
  const pool = await api.db.findOne('pools', { id });
  if (!api.assert(pool, 'pool id not found')) {
    return;
  }
  const minedTokenObject = await api.db.findOneInTable('tokens', 'tokens', { symbol: pool.minedToken });
  // eslint-disable-next-line no-template-curly-in-string
  if (!api.assert(minedTokenObject && (minedTokenObject.issuer === api.sender || (minedTokenObject.symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" && api.sender === api.owner)), 'must be issuer of minedToken')) {
    return;
  }

  const { nftTokenMiner } = pool;
  if (nftTokenMiner) {
    const nftTokenPool = await api.db.findOne('nftTokenPools', { symbol: nftTokenMiner.symbol, id: pool.id });
    if (active && !nftTokenPool) {
      const otherNftTokenPools = await api.db.find('nftTokenPools', { symbol: nftTokenMiner.symbol });
      if (!api.assert(!otherNftTokenPools || otherNftTokenPools.length < 2, 'can have at most 2 active nft token pools for nft token')) {
        return;
      }
      await api.db.insert('nftTokenPools', { symbol: nftTokenMiner.symbol, id: pool.id });
    } else if (!active && nftTokenPool) {
      await api.db.remove('nftTokenPools', nftTokenPool);
    }
  }
  pool.active = !!active;
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  pool.nextLotteryTimestamp = api.BigNumber(blockDate.getTime())
    .plus(pool.lotteryIntervalHours * 3600 * 1000).toNumber();
  await api.db.update('pools', pool);
};

actions.updatePool = async (payload) => {
  const {
    id, lotteryWinners, lotteryIntervalHours, lotteryAmount, tokenMiners,
    nftTokenMiner, callingContractInfo, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { poolUpdateFee } = params;
  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorized = api.BigNumber(poolUpdateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(poolUpdateFee);

  if (api.assert(authorized, 'you must have enough tokens to cover the update fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(id && typeof id === 'string'
      && lotteryAmount && typeof lotteryAmount === 'string' && !api.BigNumber(lotteryAmount).isNaN() && api.BigNumber(lotteryAmount).gt(0), 'invalid params')) {
    if (api.assert(Number.isInteger(lotteryWinners) && lotteryWinners >= 1 && lotteryWinners <= 20, 'invalid lotteryWinners: integer between 1 and 20 only')
      && api.assert(Number.isInteger(lotteryIntervalHours) && lotteryIntervalHours >= 1 && lotteryIntervalHours <= 720, 'invalid lotteryIntervalHours: integer between 1 and 720 only')) {
      const pool = await api.db.findOne('pools', { id });
      if (api.assert(pool, 'pool id not found')) {
        const minedTokenObject = await api.db.findOneInTable('tokens', 'tokens', { symbol: pool.minedToken });
        // eslint-disable-next-line no-template-curly-in-string
        if (api.assert(minedTokenObject && (minedTokenObject.issuer === api.sender || (minedTokenObject.symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" && api.sender === api.owner)), 'must be issuer of minedToken')
          && api.assert(api.BigNumber(lotteryAmount).dp() <= minedTokenObject.precision, 'minedToken precision mismatch for lotteryAmount')) {
          if (!callingContractInfo) {
            const validMinersChange = await validateTokenMinersChange(
              pool.tokenMiners, tokenMiners, pool.nftTokenMiner, nftTokenMiner,
            );
            if (validMinersChange) {
              pool.lotteryWinners = lotteryWinners;
              pool.lotteryIntervalHours = lotteryIntervalHours;
              pool.lotteryAmount = lotteryAmount;
              pool.tokenMiners = tokenMiners;
              pool.nftTokenMiner = nftTokenMiner;

              const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);

              if (validMinersChange.changed) {
                pool.updating.updatePoolTimestamp = api.BigNumber(blockDate.getTime()).toNumber();
                pool.updating.inProgress = true;
                pool.updating.tokenIndex = 0;
                pool.updating.nftTokenIndex = 0;
                pool.updating.lastId = 0;
                pool.totalPower = '0';
              }

              pool.nextLotteryTimestamp = api.BigNumber(blockDate.getTime())
                .plus(lotteryIntervalHours * 3600 * 1000).toNumber();
            }
          } else {
            pool.lotteryWinners = lotteryWinners;
            pool.lotteryIntervalHours = lotteryIntervalHours;
            pool.lotteryAmount = lotteryAmount;
          }
          await api.db.update('pools', pool);

          // burn the token creation fees
          if (api.sender !== api.owner && api.BigNumber(poolUpdateFee).gt(0)) {
            await api.executeSmartContract('tokens', 'transfer', {
              // eslint-disable-next-line no-template-curly-in-string
              to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: poolUpdateFee, isSignedWithActiveKey,
            });
          }
        }
      }
    }
  }
};

actions.changeNftProperty = async (payload) => {
  const {
    id, type, propertyName, changeAmount,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(id && typeof id === 'string'
      && type && typeof type === 'string'
      && propertyName && typeof propertyName === 'string'
      && changeAmount && typeof changeAmount === 'string'
      && !api.BigNumber(changeAmount).isNaN()
      && api.BigNumber(changeAmount).isFinite(), 'invalid params')) return;
  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  const pool = await api.db.findOne('pools', { id });
  if (!api.assert(pool, 'pool id not found')) return;

  const propertyIndex = pool.nftTokenMiner.properties.findIndex(p => p.name === propertyName);
  const property = pool.nftTokenMiner.properties[propertyIndex];
  if (!api.assert(property && property.burnChange, 'property not enabled for burn change')) return;

  const typeProperties = pool.nftTokenMiner.typeMap[type];
  if (!api.assert(typeProperties, 'type not found')) return;

  const burnSymbol = property.burnChange.symbol;
  const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: burnSymbol });

  const fee = api.BigNumber(changeAmount).abs().multipliedBy(property.burnChange.quantity);

  if (!api.assert(fee.dp() <= token.precision, `fee precision mismatch for amount ${fee}`)) return;

  const balance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: burnSymbol });
  const authorized = api.BigNumber(fee).lte(0)
        || (balance && api.BigNumber(balance.balance).gte(fee));

  if (!api.assert(authorized, `you must have enough tokens to cover the update fee of ${fee} ${burnSymbol}`)) return;

  typeProperties[propertyIndex] = api.BigNumber(typeProperties[propertyIndex]).plus(changeAmount);

  if (!validateNftTypeMap(pool.nftTokenMiner.typeMap, pool.nftTokenMiner.properties)) return;

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  pool.updating.updatePoolTimestamp = api.BigNumber(blockDate.getTime()).toNumber();
  pool.updating.inProgress = true;
  pool.updating.tokenIndex = 0;
  pool.updating.nftTokenIndex = 0;
  pool.updating.lastId = 0;
  pool.totalPower = '0';

  await api.db.update('pools', pool);

  // burn the token creation fees
  if (api.BigNumber(fee).gt(0)) {
    await api.executeSmartContract('tokens', 'transfer', {
      to: 'null', symbol: burnSymbol, quantity: fee, isSignedWithActiveKey,
    });
  }
};

function generatePoolId(pool) {
  const tokenMinerString = pool.externalContract && pool.externalMiners
    ? `EXT-${pool.externalMiners.replace(':', '')}`
    : pool.tokenMiners.map(t => t.symbol.replace('.', '-')).sort().join(',');
  const nftTokenMinerString = pool.nftTokenMiner ? `:${pool.nftTokenMiner.symbol}` : '';
  return `${pool.minedToken.replace('.', '-')}:${tokenMinerString}${nftTokenMinerString}`;
}

actions.createPool = async (payload) => {
  const {
    lotteryWinners, lotteryIntervalHours, lotteryAmount, minedToken, tokenMiners, nftTokenMiner,
    externalMiners, callingContractInfo, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { poolCreationFee } = params;

  if (externalMiners !== undefined) {
    if (!api.assert(typeof externalMiners === 'string', 'externalMiners must be a string')
    || !api.assert(callingContractInfo, 'must be called from a contract')) return;
  }

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(poolCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(poolCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
      && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
      && api.assert(minedToken && typeof minedToken === 'string'
        && lotteryAmount && typeof lotteryAmount === 'string' && !api.BigNumber(lotteryAmount).isNaN() && api.BigNumber(lotteryAmount).gt(0), 'invalid params')) {
    if (api.assert(minedToken.length > 0 && minedToken.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
      && api.assert(Number.isInteger(lotteryWinners) && lotteryWinners >= 1 && lotteryWinners <= 20, 'invalid lotteryWinners: integer between 1 and 20 only')
      && api.assert(Number.isInteger(lotteryIntervalHours) && lotteryIntervalHours >= 1 && lotteryIntervalHours <= 720, 'invalid lotteryIntervalHours: integer between 1 and 720 only')
    ) {
      const minedTokenObject = await api.db.findOneInTable('tokens', 'tokens', { symbol: minedToken });

      if (api.assert(minedTokenObject, 'minedToken does not exist')
        // eslint-disable-next-line no-template-curly-in-string
        && api.assert(minedTokenObject.issuer === api.sender || (minedTokenObject.symbol === "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" && api.sender === api.owner), 'must be issuer of minedToken')
        && api.assert(api.BigNumber(lotteryAmount).dp() <= minedTokenObject.precision, 'minedToken precision mismatch for lotteryAmount')) {
        if (callingContractInfo || await validateTokenMiners(tokenMiners, nftTokenMiner)) {
          const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
          const newPool = {
            minedToken,
            lotteryWinners,
            lotteryIntervalHours,
            lotteryAmount,
            tokenMiners: tokenMiners || [],
            nftTokenMiner,
            active: false,
            nextLotteryTimestamp: api.BigNumber(blockDate.getTime())
              .plus(lotteryIntervalHours * 3600 * 1000).toNumber(),
            totalPower: '0',
          };
          if (callingContractInfo) {
            if (!api.assert(!nftTokenMiner, 'external nftTokenMiner not currently supported')) return;
            newPool.externalContract = callingContractInfo.name;
            newPool.externalMiners = externalMiners;
          }
          newPool.id = generatePoolId(newPool);

          const existingPool = await api.db.findOne('pools', { id: newPool.id });
          if (api.assert(!existingPool, 'pool already exists')) {
            if (tokenMiners) {
              for (let i = 0; i < tokenMiners.length; i += 1) {
                const tokenConfig = tokenMiners[i];
                await api.db.insert('tokenPools', { symbol: tokenConfig.symbol, id: newPool.id });
              }
            }
            newPool.updating = {
              inProgress: true,
              updatePoolTimestamp: api.BigNumber(blockDate.getTime()).toNumber(),
              tokenIndex: 0,
              nftTokenIndex: 0,
              lastId: 0,
            };
            const insertedPool = await api.db.insert('pools', newPool);

            // burn the token creation fees
            if (api.sender !== api.owner && api.BigNumber(poolCreationFee).gt(0)) {
              await api.executeSmartContract('tokens', 'transfer', {
                // eslint-disable-next-line no-template-curly-in-string
                to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: poolCreationFee, isSignedWithActiveKey,
              });
            }
            api.emit('createPool', { id: insertedPool.id });
          }
        }
      }
    }
  }
};

async function runLottery(pool, params) {
  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const winningNumbers = [];
  const minedToken = await api.db.findOneInTable('tokens', 'tokens',
    { symbol: pool.minedToken });
  const winningAmount = api.BigNumber(pool.lotteryAmount).dividedBy(pool.lotteryWinners)
    .toFixed(minedToken.precision, api.BigNumber.ROUND_HALF_UP);
  // determine winning numbers
  if (!pool.externalContract) {
    for (let i = 0; i < pool.lotteryWinners; i += 1) {
      winningNumbers[i] = api.BigNumber(pool.totalPower).multipliedBy(api.random());
    }
  } else if (pool.externalContract === 'marketpools') {
    const marketpool = await api.db.findOneInTable('marketpools', 'pools', { tokenPair: pool.externalMiners });
    for (let i = 0; i < pool.lotteryWinners; i += 1) {
      winningNumbers[i] = api.BigNumber(marketpool.totalShares).multipliedBy(api.random());
    }
  }
  let offset = 0;
  let miningPowers;
  let cumulativePower = api.BigNumber(0);
  let nextCumulativePower = api.BigNumber(0);
  let computedWinners = 0;
  const winners = [];
  while (computedWinners < pool.lotteryWinners) {
    if (!pool.externalContract) {
      miningPowers = await api.db.find('miningPower', { id: pool.id, power: { $gt: { $numberDecimal: '0' } } },
        params.processQueryLimit,
        offset,
        [{ index: 'power', descending: true }, { index: '_id', descending: false }]);
    } else if (pool.externalContract === 'marketpools') {
      miningPowers = await api.db.findInTable('marketpools', 'liquidityPositions', { tokenPair: pool.externalMiners },
        params.processQueryLimit,
        offset,
        [{ index: '_id', descending: false }]);
      for (let i = 0; i < miningPowers.length; i += 1) {
        miningPowers[i].power = {
          $numberDecimal: api.BigNumber(miningPowers[i].shares)
            .toFixed(minedToken.precision, api.BigNumber.ROUND_HALF_UP),
        };
      }
    }
    for (let i = 0; i < miningPowers.length; i += 1) {
      const miningPower = miningPowers[i];
      nextCumulativePower = cumulativePower.plus(miningPower.power.$numberDecimal);
      for (let j = 0; j < pool.lotteryWinners; j += 1) {
        const currentWinningNumber = winningNumbers[j];
        if (cumulativePower.lte(currentWinningNumber)
            && nextCumulativePower.gt(currentWinningNumber)) {
          computedWinners += 1;
          winners.push({
            winner: miningPower.account,
            winningNumber: currentWinningNumber,
            winningAmount,
          });
        }
      }
      cumulativePower = nextCumulativePower;
    }
    if (computedWinners === pool.lotteryWinners || miningPowers.length < params.processQueryLimit) {
      break;
    }
    offset += params.processQueryLimit;
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

actions.checkPendingLotteries = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();

    const params = await api.db.findOne('params', {});
    const updatingLotteries = await api.db.find('pools',
      {
        'updating.inProgress': true,
      },
      params.maxLotteriesPerBlock,
      0,
      [{ index: 'id', descending: false }]);
    for (let i = 0; i < updatingLotteries.length; i += 1) {
      const pool = updatingLotteries[i];
      await resumePowerUpdate(pool, params);
    }
    const pendingLotteries = await api.db.find('pools',
      {
        active: true,
        'updating.inProgress': false,
        nextLotteryTimestamp: {
          $lte: timestamp,
        },
      },
      params.maxLotteriesPerBlock,
      0,
      [{ index: 'id', descending: false }]);

    for (let i = 0; i < pendingLotteries.length; i += 1) {
      const pool = pendingLotteries[i];
      await runLottery(pool, params);
    }
  }
};

actions.handleStakeChange = async (payload) => {
  const {
    account, symbol, quantity, delegated, callingContractInfo,
  } = payload;
  if (api.assert(callingContractInfo && callingContractInfo.name === 'tokens',
    'must be called from tokens contract')) {
    await findAndProcessAll('mining', 'tokenPools', { symbol }, async (tokenPool) => {
      const pool = await api.db.findOne('pools', { id: tokenPool.id });
      let adjusted;
      if (delegated) {
        adjusted = await updateMiningPower(pool, symbol, account, 0, quantity);
      } else {
        adjusted = await updateMiningPower(pool, symbol, account, quantity, 0);
      }
      pool.totalPower = adjusted.plus(pool.totalPower);
      await api.db.update('pools', pool);
    });
  }
};

actions.handleNftChange = async () => {};

actions.handleNftDelegationChange = async (payload) => {
  const {
    symbol, nft, add, callingContractInfo,
  } = payload;
  if (api.assert(callingContractInfo && callingContractInfo.name === 'nft',
    'must be called from nft contract')) {
    await findAndProcessAll('mining', 'nftTokenPools', { symbol }, async (tokenPool) => {
      const pool = await api.db.findOne('pools', { id: tokenPool.id });
      if (pool.updating.inProgress
          && pool.updating.tokenIndex === pool.tokenMiners.length
          && pool.updating.lastId < nft._id) {
        return;
      }
      if (!pool.active) {
        return;
      }
      if (!pool.nftTokenMiner) {
        return;
      }
      const {
        equipField, typeField, typeMap, miningPowerField,
      } = pool.nftTokenMiner;
      if (equipField) {
        return;
      }

      const typeProperties = typeMap[
        nft.properties[typeField]];
      if (typeProperties || miningPowerField) {
        const adjusted = await updateNftMiningPower(
          pool,
          nft,
          add,
          pool.updating.updatePoolTimestamp,
        );
        pool.totalPower = adjusted.plus(pool.totalPower);
        await api.db.update('pools', pool);
      }
    });
  }
};

actions.handleNftSetProperty = async (payload) => {
  const {
    symbol, nft, propertyName, oldValue, callingContractInfo,
  } = payload;
  if (api.assert(callingContractInfo && callingContractInfo.name === 'nft',
    'must be called from nft contract')) {
    const newValue = nft.properties[propertyName];
    if (oldValue === newValue) {
      return;
    }
    await findAndProcessAll('mining', 'nftTokenPools', { symbol }, async (tokenPool) => {
      const pool = await api.db.findOne('pools', { id: tokenPool.id });
      if (pool.updating.inProgress
          && pool.updating.tokenIndex === pool.tokenMiners.length
          && pool.updating.lastId < nft._id) {
        return;
      }
      if (!pool.active) {
        return;
      }
      if (!pool.nftTokenMiner) {
        return;
      }
      const { equipField, miningPowerField } = pool.nftTokenMiner;
      if (equipField && propertyName === equipField) {
        if (oldValue && api.isValidAccountName(oldValue)) {
          // unequip from previous account
          const adjusted = await updateNftMiningPower(
            pool,
            nft,
            /* add= */ false,
            pool.updating.updatePoolTimestamp,
            /* account= */ oldValue,
          );
          pool.totalPower = adjusted.plus(pool.totalPower);
        }
        if (newValue && api.isValidAccountName(newValue)) {
          // equip to account
          const adjusted = await updateNftMiningPower(
            pool,
            nft,
            /* add= */ true,
            pool.updating.updatePoolTimestamp,
            /* account= */ newValue,
          );
          pool.totalPower = adjusted.plus(pool.totalPower);
        }
      } else if (miningPowerField && propertyName === miningPowerField) {
        if (!equipField || api.isValidAccountName(nft.properties[equipField])) {
          const adjusted = await updateNftMiningPowerFromPropertyUpdate(
            pool,
            nft,
            /* account= */ equipField ? nft.properties[equipField] : null,
          );
          pool.totalPower = adjusted.plus(pool.totalPower);
        }
      }
      await api.db.update('pools', pool);
    });
  }
};
