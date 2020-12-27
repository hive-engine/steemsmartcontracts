/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'packmanager';

// BEE tokens on Hive Engine, ENG on Steem Engine, and SSC on the testnet
const UTILITY_TOKEN_SYMBOL = 'BEE';
const UTILITY_TOKEN_PRECISION = 8;

const MAX_NAME_LENGTH = 100;
const MAX_CARDS_PER_PACK = 30; // how many NFT instances can a single pack generate?
const MAX_CARDS_AT_ONCE = 60; // how many NFT instances can be generated in one open action?
const MAX_PARTITIONS = 100; // how many ways can a random roll be divided for category, rarity, team, and foil?
const MAX_ROLLS = 10; // maximum possible number of re-rolls if a random category / rarity / team throw results in no NFT instance types to choose from

// cannot issue more than this number of NFT instances in one call to issueMultiple
const MAX_NUM_NFTS_ISSUABLE = 10;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('packs');
  if (tableExists === false) {
    await api.db.createTable('packs', ['account', 'symbol', 'nft']);
    await api.db.createTable('types', ['nft', 'edition', 'typeId']);
    await api.db.createTable('foils', ['nft', 'edition', 'index']);
    await api.db.createTable('categories', ['nft', 'edition', 'index']);
    await api.db.createTable('rarities', ['nft', 'edition', 'index']);
    await api.db.createTable('teams', ['nft', 'edition', 'index']);
    await api.db.createTable('managedNfts', ['nft']);
    await api.db.createTable('params');

    const params = {};
    params.registerFee = '1000';
    params.typeAddFee = '1';
    await api.db.insert('params', params);
  }
};

// ----- START UTILITY FUNCTIONS -----

const doRandomRoll = (partition) => {
  let result = 0;

  const roll = Math.floor(api.random() * partition[partition.length - 1]) + 1;
  for (let i = 0; i < partition.length; i += 1) {
    if (roll > partition[i]) {
      result += 1;
    } else {
      break;
    }
  }

  // sanity check to ensure result is properly capped
  // (this should never actually happen)
  if (result >= partition.length) {
    result = partition.length - 1;
  }

  return result;
};

const isValidPartition = (partition) => {
  if (partition && typeof partition === 'object' && Array.isArray(partition) && partition.length >= 1 && partition.length <= MAX_PARTITIONS) {
    let prevNum = 0;
    for (let i = 0; i < partition.length; i += 1) {
      const val = partition[i];
      if (!(typeof val === 'number' && Number.isInteger(val) && val > prevNum)) {
        return false;
      }
      prevNum = val;
    }
    return true;
  }
  return false;
};

const isTokenTransferVerified = (result, from, to, symbol, quantity, eventStr) => {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens' && el.event === eventStr
    && el.data.from === from && el.data.to === to && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
    return true;
  }
  return false;
};

const countNftIssuance = (result, from, to, symbol) => {
  let count = 0;
  if (result.errors === undefined && result.events) {
    const issuanceEvents = result.events.filter(e => e.contract === 'nft' && e.event === 'issue'
      && e.data.from === from && e.data.to === to && e.data.symbol === symbol);
    count = issuanceEvents.length;
  }
  return count;
};

const calculateBalance = (balance, quantity, precision, add) => (add
  ? api.BigNumber(balance).plus(quantity).toFixed(precision)
  : api.BigNumber(balance).minus(quantity).toFixed(precision));

const countDecimals = value => api.BigNumber(value).dp();

const verifyTokenBalance = async (amount, symbol, account) => {
  if (api.BigNumber(amount).lte(0)) {
    return true;
  }
  const tokenBalance = await api.db.findOneInTable('tokens', 'balances', { account, symbol });
  if (tokenBalance && api.BigNumber(tokenBalance.balance).gte(amount)) {
    return true;
  }
  return false;
};

const transferFee = async (amount, dest, isSignedWithActiveKey) => {
  const actionStr = (dest === CONTRACT_NAME) ? 'transferToContract' : 'transfer';
  if (api.BigNumber(amount).gt(0)) {
    const res = await api.executeSmartContract('tokens', actionStr, {
      to: dest, symbol: UTILITY_TOKEN_SYMBOL, quantity: amount, isSignedWithActiveKey,
    });
    // check if the tokens were sent
    if (!isTokenTransferVerified(res, api.sender, dest, UTILITY_TOKEN_SYMBOL, amount, actionStr)) {
      return false;
    }
  }
  return true;
};

// ----- END UTILITY FUNCTIONS -----

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    registerFee,
    typeAddFee,
  } = payload;

  const params = await api.db.findOne('params', {});

  if (registerFee && typeof registerFee === 'string' && !api.BigNumber(registerFee).isNaN() && api.BigNumber(registerFee).gte(0)) {
    params.registerFee = registerFee;
  }
  if (typeAddFee && typeof typeAddFee === 'string' && !api.BigNumber(typeAddFee).isNaN() && api.BigNumber(typeAddFee).gte(0)) {
    params.typeAddFee = typeAddFee;
  }

  await api.db.update('params', params);
};

actions.deposit = async (payload) => {
  const {
    nftSymbol,
    amount,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(nftSymbol && typeof nftSymbol === 'string'
      && amount && typeof amount === 'string' && !api.BigNumber(amount).isNaN()
      && api.BigNumber(amount).gt(0) && countDecimals(amount) <= UTILITY_TOKEN_PRECISION, 'invalid params')) {
    const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
    if (api.assert(underManagement !== null, 'NFT not under management')) {
      const hasEnoughBalance = await verifyTokenBalance(amount, UTILITY_TOKEN_SYMBOL, api.sender);
      if (api.assert(hasEnoughBalance, 'not enough tokens to deposit')) {
        // send tokens to the contract and update pool balance
        if (!(await transferFee(amount, CONTRACT_NAME, isSignedWithActiveKey))) {
          return false;
        }

        underManagement.feePool = calculateBalance(underManagement.feePool, amount, UTILITY_TOKEN_PRECISION, true);
        await api.db.update('managedNfts', underManagement);

        api.emit('deposit', {
          nft: nftSymbol, newFeePool: underManagement.feePool,
        });

        return true;
      }
    }
  }
  return false;
};

actions.deleteType = async (payload) => {
  const {
    nftSymbol,
    edition,
    typeId,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(nftSymbol && typeof nftSymbol === 'string'
      && typeId !== undefined && typeof typeId === 'number' && Number.isInteger(typeId) && typeId >= 0
      && edition !== undefined && typeof edition === 'number' && Number.isInteger(edition) && edition >= 0, 'invalid params')) {
    // make sure user is authorized for this NFT
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
    if (api.assert(nft !== null, 'NFT symbol must exist')) {
      if (api.assert(nft.issuer === api.sender, 'not authorized to delete types')
        && api.assert(nft.circulatingSupply === 0, 'NFT instances must not be in circulation')) {
        const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
        if (api.assert(underManagement !== null, 'NFT not under management')) {
          const theType = await api.db.findOne('types', { nft: nftSymbol, edition, typeId });
          if (theType !== null) {
            // all checks have passed, now remove the type
            await api.db.remove('types', theType);

            api.emit('deleteType', { nft: nftSymbol, edition, typeId });

            return true;
          }
        }
      }
    }
  }
  return false;
};

actions.updateType = async (payload) => {
  const {
    nftSymbol,
    edition,
    typeId,
    category,
    rarity,
    team,
    name,
    isSignedWithActiveKey,
  } = payload;

  // nothing to do if there's not at least one field to update
  if (name === undefined && category === undefined && rarity === undefined && team === undefined) {
    return false;
  }

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(name === undefined || (name && typeof name === 'string'
      && api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= MAX_NAME_LENGTH), `invalid type name: letters, numbers, whitespaces only, max length of ${MAX_NAME_LENGTH}`)
    && api.assert(nftSymbol && typeof nftSymbol === 'string'
      && typeId !== undefined && typeof typeId === 'number' && Number.isInteger(typeId) && typeId >= 0
      && edition !== undefined && typeof edition === 'number' && Number.isInteger(edition) && edition >= 0
      && (category === undefined || (typeof category === 'number' && Number.isInteger(category) && category >= 0))
      && (rarity === undefined || (typeof rarity === 'number' && Number.isInteger(rarity) && rarity >= 0))
      && (team === undefined || (typeof team === 'number' && Number.isInteger(team) && team >= 0)), 'invalid params')) {
    // make sure user is authorized for this NFT
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
    if (api.assert(nft !== null, 'NFT symbol must exist')) {
      if (api.assert(nft.issuer === api.sender, 'not authorized to update types')) {
        const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
        if (api.assert(underManagement !== null, 'NFT not under management')) {
          if (api.assert(edition.toString() in underManagement.editionMapping, 'edition not registered')) {
            const editionMapping = underManagement.editionMapping[edition.toString()];
            if (api.assert((category === undefined || !editionMapping.categoryRO)
              && (rarity === undefined || !editionMapping.rarityRO)
              && (team === undefined || !editionMapping.teamRO)
              && (name === undefined || !editionMapping.nameRO), 'cannot edit read-only properties')) {
              const theType = await api.db.findOne('types', { nft: nftSymbol, edition, typeId });
              if (api.assert(theType !== null, 'type does not exist')) {
                const update = {
                  nft: nftSymbol,
                  edition,
                  typeId,
                };

                // all checks have passed, now we can update stuff
                if (name !== undefined) {
                  update.oldName = theType.name;
                  theType.name = name;
                  update.newName = name;
                }
                if (category !== undefined) {
                  update.oldCategory = theType.category;
                  theType.category = category;
                  update.newCategory = category;
                }
                if (rarity !== undefined) {
                  update.oldRarity = theType.rarity;
                  theType.rarity = rarity;
                  update.newRarity = rarity;
                }
                if (team !== undefined) {
                  update.oldTeam = theType.team;
                  theType.team = team;
                  update.newTeam = team;
                }

                await api.db.update('types', theType);

                api.emit('updateType', update);

                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
};

actions.addType = async (payload) => {
  const {
    nftSymbol,
    edition,
    category,
    rarity,
    team,
    name,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(name && typeof name === 'string'
      && api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= MAX_NAME_LENGTH, `invalid type name: letters, numbers, whitespaces only, max length of ${MAX_NAME_LENGTH}`)
    && api.assert(nftSymbol && typeof nftSymbol === 'string'
      && edition !== undefined && typeof edition === 'number' && Number.isInteger(edition) && edition >= 0
      && category !== undefined && typeof category === 'number' && Number.isInteger(category) && category >= 0
      && rarity !== undefined && typeof rarity === 'number' && Number.isInteger(rarity) && rarity >= 0
      && team !== undefined && typeof team === 'number' && Number.isInteger(team) && team >= 0, 'invalid params')) {
    // make sure user is authorized for this NFT
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
    if (api.assert(nft !== null, 'NFT symbol must exist')) {
      if (api.assert(nft.issuer === api.sender, 'not authorized to add a type')) {
        // make sure registration fee can be paid
        const params = await api.db.findOne('params', {});
        const hasEnoughBalance = await verifyTokenBalance(params.typeAddFee, UTILITY_TOKEN_SYMBOL, api.sender);

        if (api.assert(hasEnoughBalance, 'you must have enough tokens to cover the type add fee')) {
          const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
          if (api.assert(underManagement !== null, 'NFT not under management')) {
            if (api.assert(edition.toString() in underManagement.editionMapping, 'edition not registered')) {
              // burn the type add fee
              if (!(await transferFee(params.typeAddFee, 'null', isSignedWithActiveKey))) {
                return false;
              }

              const newTypeId = underManagement.editionMapping[edition.toString()].nextTypeId;

              const newType = {
                nft: nftSymbol,
                edition,
                typeId: newTypeId,
                category,
                rarity,
                team,
                name,
              };
              const result = await api.db.insert('types', newType);

              underManagement.editionMapping[edition.toString()].nextTypeId = newTypeId + 1;
              await api.db.update('managedNfts', underManagement);

              api.emit('addType', {
                // eslint-disable-next-line no-underscore-dangle
                nft: nftSymbol, edition, typeId: newTypeId, rowId: result._id,
              });

              return true;
            }
          }
        }
      }
    }
  }
  return false;
};

actions.setTraitName = async (payload) => {
  const {
    nftSymbol,
    edition,
    trait,
    index,
    name,
    isSignedWithActiveKey,
  } = payload;
  const validTraits = ['foil', 'category', 'rarity', 'team'];
  const tableMapping = {
    foil: 'foils',
    category: 'categories',
    rarity: 'rarities',
    team: 'teams',
  };

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(name && typeof name === 'string' && api.validator.isAlphanumeric(api.validator.blacklist(name, ' '))
      && name.length > 0 && name.length <= MAX_NAME_LENGTH, `invalid trait name: letters, numbers, whitespaces only, max length of ${MAX_NAME_LENGTH}`)
    && api.assert(nftSymbol && typeof nftSymbol === 'string'
      && trait && typeof trait === 'string' && validTraits.includes(trait)
      && index !== undefined && typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < MAX_PARTITIONS
      && edition !== undefined && typeof edition === 'number' && Number.isInteger(edition) && edition >= 0, 'invalid params')) {
    // make sure user is authorized for this NFT
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
    if (api.assert(nft !== null, 'NFT symbol must exist')) {
      if (api.assert(nft.issuer === api.sender, 'not authorized for updates')) {
        const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
        if (api.assert(underManagement !== null, 'NFT not under management')) {
          if (api.assert(edition.toString() in underManagement.editionMapping, 'edition not registered')) {
            const currentTrait = await api.db.findOne(tableMapping[trait], { nft: nftSymbol, edition, index });
            if (currentTrait !== null) {
              // do an update
              if (name !== currentTrait.name) {
                const oldName = currentTrait.name;
                currentTrait.name = name;

                await api.db.update(tableMapping[trait], currentTrait);

                api.emit('updateTraitName', {
                  nft: nftSymbol,
                  edition,
                  trait,
                  index,
                  oldName,
                  newName: name,
                });
              }
            } else {
              // insert a new entry
              const newTrait = {
                nft: nftSymbol,
                edition,
                index,
                name,
              };

              await api.db.insert(tableMapping[trait], newTrait);

              api.emit('setTraitName', {
                nft: nftSymbol,
                edition,
                trait,
                index,
                name,
              });
            }
          }
        }
      }
    }
  }
};

actions.updateEdition = async (payload) => {
  const {
    nftSymbol,
    edition,
    editionName,
    categoryRO,
    rarityRO,
    teamRO,
    nameRO,
    isSignedWithActiveKey,
  } = payload;

  // nothing to do if there's not at least one field to update
  if (editionName === undefined && categoryRO === undefined && rarityRO === undefined && teamRO === undefined && nameRO === undefined) {
    return false;
  }

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(editionName === undefined || (editionName && typeof editionName === 'string' && api.validator.isAlphanumeric(api.validator.blacklist(editionName, ' '))
      && editionName.length > 0 && editionName.length <= MAX_NAME_LENGTH), `invalid edition name: letters, numbers, whitespaces only, max length of ${MAX_NAME_LENGTH}`)
    && api.assert(nftSymbol && typeof nftSymbol === 'string'
      && (categoryRO === undefined || (categoryRO && typeof categoryRO === 'boolean'))
      && (rarityRO === undefined || (rarityRO && typeof rarityRO === 'boolean'))
      && (teamRO === undefined || (teamRO && typeof teamRO === 'boolean'))
      && (nameRO === undefined || (nameRO && typeof nameRO === 'boolean'))
      && edition !== undefined && typeof edition === 'number' && Number.isInteger(edition) && edition >= 0, 'invalid params')) {
    // make sure user is authorized for this NFT
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
    if (api.assert(nft !== null, 'NFT symbol must exist')) {
      if (api.assert(nft.issuer === api.sender, 'not authorized for updates')) {
        const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
        if (api.assert(underManagement !== null, 'NFT not under management')) {
          if (api.assert(edition.toString() in underManagement.editionMapping, 'edition not registered')) {
            const editionMap = underManagement.editionMapping[edition.toString()];

            const update = {
              nft: nftSymbol,
              edition,
            };

            // all checks have passed, now we can update stuff
            if (editionName !== undefined) {
              update.oldEditionName = editionMap.editionName;
              editionMap.editionName = editionName;
              update.newEditionName = editionName;
            }
            if (categoryRO) {
              editionMap.categoryRO = true;
              update.categoryRO = true;
            }
            if (rarityRO) {
              editionMap.rarityRO = true;
              update.rarityRO = true;
            }
            if (teamRO) {
              editionMap.teamRO = true;
              update.teamRO = true;
            }
            if (nameRO) {
              editionMap.nameRO = true;
              update.nameRO = true;
            }

            await api.db.update('managedNfts', underManagement);

            api.emit('updateEdition', update);

            return true;
          }
        }
      }
    }
  }
  return false;
};

actions.updatePack = async (payload) => {
  const {
    packSymbol,
    nftSymbol,
    edition,
    cardsPerPack,
    foilChance,
    categoryChance,
    rarityChance,
    teamChance,
    numRolls,
    isFinalized,
    isSignedWithActiveKey,
  } = payload;

  // nothing to do if there's not at least one field to update
  if (edition === undefined && cardsPerPack === undefined && foilChance === undefined && categoryChance === undefined && rarityChance === undefined && teamChance === undefined && numRolls === undefined && isFinalized === undefined) {
    return false;
  }

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(packSymbol && typeof packSymbol === 'string'
      && nftSymbol && typeof nftSymbol === 'string'
      && (isFinalized === undefined || (isFinalized && typeof isFinalized === 'boolean'))
      && (edition === undefined || (typeof edition === 'number' && Number.isInteger(edition) && edition >= 0))
      && (numRolls === undefined || (typeof numRolls === 'number' && Number.isInteger(numRolls) && numRolls >= 1 && numRolls <= MAX_ROLLS))
      && (foilChance === undefined || isValidPartition(foilChance))
      && (categoryChance === undefined || isValidPartition(categoryChance))
      && (rarityChance === undefined || isValidPartition(rarityChance))
      && (teamChance === undefined || isValidPartition(teamChance))
      && (cardsPerPack === undefined || (typeof cardsPerPack === 'number' && Number.isInteger(cardsPerPack) && cardsPerPack >= 1 && cardsPerPack <= MAX_CARDS_PER_PACK)), 'invalid params')) {
    const settings = await api.db.findOne('packs', { symbol: packSymbol, nft: nftSymbol });
    if (api.assert(settings !== null, 'pack not registered for this NFT')) {
      if (api.assert(settings.account === api.sender, 'not authorized to update settings')
        && api.assert(!settings.isFinalized, 'pack settings already finalized')) {
        // if edition is being updated, a registration for the new edition must
        // already have been made
        if (edition !== undefined) {
          const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
          if (!api.assert(underManagement !== null && edition.toString() in underManagement.editionMapping, 'edition not registered')) {
            return false;
          }
        }

        const update = {
          symbol: packSymbol,
          nft: nftSymbol,
        };

        // all checks have passed, now we can update stuff
        if (edition !== undefined) {
          update.oldEdition = settings.edition;
          settings.edition = edition;
          update.newEdition = edition;
        }
        if (cardsPerPack !== undefined) {
          update.oldCardsPerPack = settings.cardsPerPack;
          settings.cardsPerPack = cardsPerPack;
          update.newCardsPerPack = cardsPerPack;
        }
        if (foilChance !== undefined) {
          update.oldFoilChance = settings.foilChance;
          settings.foilChance = foilChance;
          update.newFoilChance = foilChance;
        }
        if (categoryChance !== undefined) {
          update.oldCategoryChance = settings.categoryChance;
          settings.categoryChance = categoryChance;
          update.newCategoryChance = categoryChance;
        }
        if (rarityChance !== undefined) {
          update.oldRarityChance = settings.rarityChance;
          settings.rarityChance = rarityChance;
          update.newRarityChance = rarityChance;
        }
        if (teamChance !== undefined) {
          update.oldTeamChance = settings.teamChance;
          settings.teamChance = teamChance;
          update.newTeamChance = teamChance;
        }
        if (numRolls !== undefined) {
          update.oldNumRolls = settings.numRolls;
          settings.numRolls = numRolls;
          update.newNumRolls = numRolls;
        }
        if (isFinalized) {
          settings.isFinalized = true;
          update.isFinalized = true;
        }

        await api.db.update('packs', settings);

        api.emit('updatePack', update);

        return true;
      }
    }
  }
  return false;
};

actions.registerPack = async (payload) => {
  const {
    packSymbol,
    nftSymbol,
    edition,
    editionName,
    cardsPerPack,
    foilChance,
    categoryChance,
    rarityChance,
    teamChance,
    numRolls,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(editionName === undefined || (editionName && typeof editionName === 'string'
      && api.validator.isAlphanumeric(api.validator.blacklist(editionName, ' ')) && editionName.length > 0 && editionName.length <= MAX_NAME_LENGTH), `invalid edition name: letters, numbers, whitespaces only, max length of ${MAX_NAME_LENGTH}`)
    && api.assert(packSymbol && typeof packSymbol === 'string'
      && nftSymbol && typeof nftSymbol === 'string'
      && edition !== undefined && typeof edition === 'number' && Number.isInteger(edition) && edition >= 0
      && numRolls !== undefined && typeof numRolls === 'number' && Number.isInteger(numRolls) && numRolls >= 1 && numRolls <= MAX_ROLLS
      && isValidPartition(foilChance) && isValidPartition(categoryChance) && isValidPartition(rarityChance) && isValidPartition(teamChance)
      && cardsPerPack !== undefined && typeof cardsPerPack === 'number' && Number.isInteger(cardsPerPack) && cardsPerPack >= 1 && cardsPerPack <= MAX_CARDS_PER_PACK, 'invalid params')) {
    // make sure registration fee can be paid
    const params = await api.db.findOne('params', {});
    const hasEnoughBalance = await verifyTokenBalance(params.registerFee, UTILITY_TOKEN_SYMBOL, api.sender);

    if (api.assert(hasEnoughBalance, 'you must have enough tokens to cover the registration fee')) {
      // verify pack & NFT symbols exist, and NFT was created through this contract
      const packToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: packSymbol });
      if (api.assert(packToken !== null, 'pack symbol must exist')) {
        const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
        if (api.assert(underManagement !== null, 'NFT not under management')) {
          const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
          if (api.assert(nft !== null, 'NFT symbol must exist')
            && api.assert(nft.issuer === api.sender, 'not authorized to register')) {
            // make sure this pack / NFT combo  hasn't been registered yet
            const settings = await api.db.findOne('packs', { symbol: packSymbol, nft: nftSymbol });
            if (api.assert(settings === null, `pack already registered for ${nftSymbol}`)) {
              // verify editionName has been provided if we are defining a new edition
              if (!api.assert((edition.toString() in underManagement.editionMapping) || (editionName && !(edition.toString() in underManagement.editionMapping)), 'must provide a name for the new edition')) {
                return false;
              }

              // burn the registration fee
              if (!(await transferFee(params.registerFee, 'null', isSignedWithActiveKey))) {
                return false;
              }

              const newSettings = {
                account: api.sender,
                symbol: packSymbol,
                nft: nftSymbol,
                edition,
                cardsPerPack,
                foilChance,
                categoryChance,
                rarityChance,
                teamChance,
                numRolls,
                isFinalized: false,
              };

              // if this is a registration for a new edition, we need
              // to start a new edition mapping
              if (!(edition.toString() in underManagement.editionMapping)) {
                const newMapping = {
                  nextTypeId: 0,
                  editionName,
                  categoryRO: false,
                  rarityRO: false,
                  teamRO: false,
                  nameRO: false,
                };
                underManagement.editionMapping[edition.toString()] = newMapping;
                await api.db.update('managedNfts', underManagement);
              }

              await api.db.insert('packs', newSettings);

              api.emit('registerPack', {
                account: api.sender,
                symbol: packSymbol,
                nft: nftSymbol,
              });
              return true;
            }
          }
        }
      }
    }
  }
  return false;
};

actions.createNft = async (payload) => {
  const {
    name,
    orgName,
    productName,
    symbol,
    url,
    isFoilReadOnly,
    isTypeReadOnly,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
      && (isFoilReadOnly === undefined || typeof isFoilReadOnly === 'boolean')
      && (isTypeReadOnly === undefined || typeof isTypeReadOnly === 'boolean'), 'invalid params')) {
    // calculate NFT creation costs based on contract params
    const nftParams = await api.db.findOneInTable('nft', 'params', {});
    const {
      nftCreationFee,
    } = nftParams;
    const hasEnoughBalance = await verifyTokenBalance(nftCreationFee, UTILITY_TOKEN_SYMBOL, api.sender);

    if (api.assert(hasEnoughBalance, 'you must have enough tokens to cover the NFT creation')) {
      // verify nft doesn't already exist
      let nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
      if (api.assert(nft === null, 'symbol already exists')) {
        // We don't specify maxSupply, which means the supply
        // will be unlimited. But indirectly the supply is limited by the
        // supply of the pack tokens.
        await api.executeSmartContract('nft', 'create', {
          name,
          symbol,
          orgName,
          productName,
          url,
          authorizedIssuingAccounts: [],
          authorizedIssuingContracts: [CONTRACT_NAME],
          isSignedWithActiveKey,
        });

        // verify nft was created OK
        nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
        if (api.assert(nft !== null, 'error creating NFT')) {
          const finalIsFoilReadOnly = isFoilReadOnly === undefined ? true : isFoilReadOnly;
          const finalIsTypeReadOnly = isTypeReadOnly === undefined ? true : isTypeReadOnly;

          // Edition only gets set once at issuance and never changes, so we
          // can make it read only.
          await api.executeSmartContract('nft', 'addProperty', {
            symbol,
            name: 'edition',
            type: 'number',
            isReadOnly: true,
            authorizedEditingAccounts: [],
            authorizedEditingContracts: [CONTRACT_NAME],
            isSignedWithActiveKey,
          });

          await api.executeSmartContract('nft', 'addProperty', {
            symbol,
            name: 'foil',
            type: 'number',
            isReadOnly: finalIsFoilReadOnly,
            authorizedEditingContracts: [CONTRACT_NAME],
            isSignedWithActiveKey,
          });

          await api.executeSmartContract('nft', 'addProperty', {
            symbol,
            name: 'type',
            type: 'number',
            isReadOnly: finalIsTypeReadOnly,
            authorizedEditingContracts: [CONTRACT_NAME],
            isSignedWithActiveKey,
          });

          // now verify data properties were added OK
          nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
          const propertyCount = Object.keys(nft.properties).length;
          if (api.assert(propertyCount === 3, 'NFT created but error adding data properties')) {
            await api.executeSmartContract('nft', 'setGroupBy', {
              symbol,
              properties: ['edition', 'foil', 'type'],
              isSignedWithActiveKey,
            });

            // indicates this contract is responsible for issuance of the NFT
            const newRecord = {
              nft: symbol,
              feePool: '0',
              editionMapping: {},
            };
            await api.db.insert('managedNfts', newRecord);

            // finally, verify groupBy was set OK
            nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
            const groupByCount = nft.groupBy.length;
            if (api.assert(groupByCount === 3, 'NFT created with data properties, but error setting groupBy')) {
              api.emit('createNft', {
                symbol,
              });
            }
          }
        }
      }
    }
  }
};

// generate issuance data for a random NFT instance
const generateRandomInstance = (settings, nftSymbol, to, types) => {
  const foil = doRandomRoll(settings.foilChance);

  let candidateTypes = [];
  let rollCount = 0;

  // filter types by the chosen category / rarity / team and select
  // one at random, re-rolling if there are no types available for the
  // chosen combination
  while (candidateTypes.length === 0 && rollCount < settings.numRolls) {
    const category = doRandomRoll(settings.categoryChance);
    const rarity = doRandomRoll(settings.rarityChance);
    const team = doRandomRoll(settings.teamChance);

    candidateTypes = types.filter(t => t.category === category && t.rarity === rarity && t.team === team);
    rollCount += 1;
  }
  const type = candidateTypes.length > 0 ? candidateTypes[Math.floor(api.random() * candidateTypes.length)].typeId : 0;

  const properties = {
    edition: settings.edition,
    foil,
    type,
  };

  const instance = {
    symbol: nftSymbol,
    fromType: 'contract',
    to,
    feeSymbol: UTILITY_TOKEN_SYMBOL,
    properties,
  };

  return instance;
};

actions.open = async (payload) => {
  const {
    packSymbol,
    nftSymbol,
    packs,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(packSymbol && typeof packSymbol === 'string'
      && nftSymbol && typeof nftSymbol === 'string'
      && packs !== undefined && typeof packs === 'number' && Number.isInteger(packs) && packs >= 1 && packs <= 999, 'invalid params')) {
    const settings = await api.db.findOne('packs', { symbol: packSymbol, nft: nftSymbol });
    if (api.assert(settings !== null, 'pack does not open this NFT')) {
      // verify user actually has the desired number of packs to open
      const hasEnoughPacks = await verifyTokenBalance(packs, packSymbol, api.sender);
      if (api.assert(hasEnoughPacks, 'you must have enough packs')) {
        const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
        const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
        if (api.assert(nft !== null, 'NFT symbol must exist')
          && api.assert(underManagement !== null, 'NFT not under management')) {
          // for performance reasons cap number of NFT instances that can be generated in one action
          const numNfts = packs * settings.cardsPerPack;
          if (!api.assert(numNfts <= MAX_CARDS_AT_ONCE, 'unable to open that many packs at once')) {
            return false;
          }
          // verify this contract has enough in the fee pool to pay the NFT issuance fees
          const nftParams = await api.db.findOneInTable('nft', 'params', {});
          const { nftIssuanceFee } = nftParams;
          const propertyCount = Object.keys(nft.properties).length;
          const oneTokenIssuanceFee = api.BigNumber(nftIssuanceFee[UTILITY_TOKEN_SYMBOL]).multipliedBy(propertyCount + 1);
          const totalIssuanceFee = oneTokenIssuanceFee.multipliedBy(numNfts);
          const canAffordIssuance = api.BigNumber(underManagement.feePool).gte(totalIssuanceFee);
          if (api.assert(canAffordIssuance, 'contract cannot afford issuance')) {
            // fetch all our instance types
            const types = await api.db.find(
              'types',
              { nft: nftSymbol, edition: settings.edition },
              0,
              0,
              [{ index: 'typeId', descending: false }, { index: '_id', descending: false }],
            );
            if (!api.assert(types.length >= 1, 'NFT must have at least 1 instance type')) {
              return false;
            }

            // burn the pack tokens
            let res = await api.executeSmartContract('tokens', 'transfer', {
              to: 'null', symbol: packSymbol, quantity: packs.toString(), isSignedWithActiveKey,
            });
            if (!api.assert(isTokenTransferVerified(res, api.sender, 'null', packSymbol, packs.toString(), 'transfer'), 'unable to transfer pack tokens')) {
              return false;
            }

            // issue the NFT instances
            let issueCounter = 0;
            let verifiedCount = 0;
            let instances = [];
            while (issueCounter < numNfts) {
              instances.push(generateRandomInstance(settings, nftSymbol, api.sender, types));
              issueCounter += 1;
              if (instances.length === MAX_NUM_NFTS_ISSUABLE) {
                res = await api.executeSmartContract('nft', 'issueMultiple', {
                  instances,
                  isSignedWithActiveKey,
                });
                verifiedCount += countNftIssuance(res, CONTRACT_NAME, api.sender, nftSymbol);
                instances = [];
              }
            }
            // take care of any leftover instances
            if (instances.length > 0) {
              res = await api.executeSmartContract('nft', 'issueMultiple', {
                instances,
                isSignedWithActiveKey,
              });
              verifiedCount += countNftIssuance(res, CONTRACT_NAME, api.sender, nftSymbol);
            }

            // update fee pool balance
            underManagement.feePool = calculateBalance(underManagement.feePool, totalIssuanceFee, UTILITY_TOKEN_PRECISION, false);
            await api.db.update('managedNfts', underManagement);

            // sanity check to confirm NFT issuance
            if (!api.assert(verifiedCount === numNfts, `unable to issue all NFT instances; ${verifiedCount} of ${numNfts} issued`)) {
              return false;
            }

            return true;
          }
        }
      }
    }
  }
  return false;
};
