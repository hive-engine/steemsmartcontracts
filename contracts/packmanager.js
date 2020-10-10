/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'packmanager';

// BEE tokens on Hive Engine, ENG on Steem Engine, and SSC on the testnet
const UTILITY_TOKEN_SYMBOL = 'BEE';
const UTILITY_TOKEN_PRECISION = 8;

const MAX_NAME_LENGTH = 100;
const MAX_CARDS_PER_PACK = 30; // how many NFT instances can a single pack generate?
const MAX_PACKS_AT_ONCE = 10; // how many packs can we open in one action?

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('packs');
  if (tableExists === false) {
    await api.db.createTable('packs', ['account', 'symbol', 'nft']);
    await api.db.createTable('types', ['nft', 'edition', 'typeId']);
    await api.db.createTable('managedNfts', ['nft']);
    await api.db.createTable('params');

    const params = {};
    params.registerFee = '1000';
    params.typeAddFee = '1';
    await api.db.insert('params', params);
  }
};

// ----- START UTILITY FUNCTIONS -----

const isTokenTransferVerified = (result, from, to, symbol, quantity, eventStr) => {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens' && el.event === eventStr
    && el.data.from === from && el.data.to === to && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
    return true;
  }
  return false;
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
          const theType = await api.db.findOne('types', { nft: nftSymbol, edition: edition, typeId: typeId });
          if (theType !== null) {
            // all checks have passed, now remove the type
            await api.db.remove('types', theType);

            api.emit('deleteType', { nft: nftSymbol, edition: edition, typeId: typeId });

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
          if (api.assert(nft.circulatingSupply === 0 || ((category === undefined || !underManagement.categoryRO)
            && (rarity === undefined || !underManagement.rarityRO)
            && (team === undefined || !underManagement.teamRO)
            && (name === undefined || !underManagement.nameRO)), 'cannot edit read-only properties')) {
            const theType = await api.db.findOne('types', { nft: nftSymbol, edition: edition, typeId: typeId });
            if (api.assert(theType !== null, 'type does not exist')) {
              const update = {
                nft: nftSymbol,
                edition: edition,
                typeId: typeId,
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
                edition: edition,
                typeId: newTypeId,
                category: category,
                rarity: rarity,
                team: team,
                name: name,
              };
              const result = await api.db.insert('types', newType);

              underManagement.editionMapping[edition.toString()].nextTypeId = newTypeId + 1;
              await api.db.update('managedNfts', underManagement);

              api.emit('addType', {
                nft: nftSymbol, edition: edition, typeId: newTypeId, rowId: result._id,
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

// TODO: add other creation settings
actions.updateSettings = async (payload) => {
  const {
    packSymbol,
    nftSymbol,
    edition,
    cardsPerPack,
    isSignedWithActiveKey,
  } = payload;

  // nothing to do if there's not at least one field to update
  if (edition === undefined && cardsPerPack === undefined) {
    return false;
  }

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(packSymbol && typeof packSymbol === 'string'
      && nftSymbol && typeof nftSymbol === 'string'
      && (edition === undefined || (typeof edition === 'number' && Number.isInteger(edition) && edition >= 0))
      && (cardsPerPack === undefined || (typeof cardsPerPack === 'number' && Number.isInteger(cardsPerPack) && cardsPerPack >= 1 && cardsPerPack <= MAX_CARDS_PER_PACK)), 'invalid params')) {
    const settings = await api.db.findOne('packs', { symbol: packSymbol, nft: nftSymbol });
    if (api.assert(settings !== null, 'pack not registered for this NFT')) {
      if (api.assert(settings.account === api.sender, 'not authorized to update settings')) {
        const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
        if (api.assert(nft !== null, 'NFT symbol must exist')
          && api.assert(nft.circulatingSupply === 0, 'NFT instances must not be in circulation')) {
          // if edition is being updated, a registration for the new edition must
          // already have been made
          if (edition !== undefined) {
            const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
            if (!api.assert(underManagement !== null && edition.toString() in underManagement.editionMapping, 'edition not registered')) {
              return false;
            }
          }

          const update = {
            account: api.sender,
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

          await api.db.update('packs', settings);

          api.emit('updateSettings', update);

          return true;
        }
      }
    }
  }
  return false;
};

// TODO: add other creation settings
actions.registerPack = async (payload) => {
  const {
    packSymbol,
    nftSymbol,
    edition,
    cardsPerPack,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(packSymbol && typeof packSymbol === 'string'
      && nftSymbol && typeof nftSymbol === 'string'
      && edition !== undefined && typeof edition === 'number' && Number.isInteger(edition) && edition >= 0
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
            && api.assert(nft.issuer === api.sender, 'not authorized to register')
            && api.assert(nft.circulatingSupply === 0, 'unable to register; NFT instances already issued')) {
            // make sure this pack / NFT combo  hasn't been registered yet
            const settings = await api.db.findOne('packs', { symbol: packSymbol, nft: nftSymbol });
            if (api.assert(settings === null, `pack already registered for ${nftSymbol}`)) {
              // burn the registration fee
              if (!(await transferFee(params.registerFee, 'null', isSignedWithActiveKey))) {
                return false;
              }

              const newSettings = {
                account: api.sender,
                symbol: packSymbol,
                nft: nftSymbol,
                edition: edition,
                cardsPerPack: cardsPerPack,
              };

              // if this is a registration for a new edition, we need
              // to start a new edition mapping
              if (!(edition.toString() in underManagement.editionMapping)) {
                const newMapping = {
                  nextTypeId: 0
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
      dataPropertyCreationFee,
    } = nftParams;
    // TODO: can remove the below if not more than 3 data properties
    //const propertyFee = api.BigNumber(dataPropertyCreationFee).multipliedBy(1); // first 3 data properties are free
    //const totalFeeAmount = api.BigNumber(nftCreationFee).plus(propertyFee);
    const hasEnoughBalance = await verifyTokenBalance(nftCreationFee, UTILITY_TOKEN_SYMBOL, api.sender);

    if (api.assert(hasEnoughBalance, 'you must have enough tokens to cover the NFT creation')) {
      // verify nft doesn't already exist
      let nft = await api.db.findOneInTable('nft', 'nfts', { symbol: symbol });
      if (api.assert(nft === null, 'symbol already exists')) {
        // We don't specify maxSupply, which means the supply
        // will be unlimited. But indirectly the supply is limited by the
        // supply of the pack tokens.
        await api.executeSmartContract('nft', 'create', {
          name: name,
          symbol: symbol,
          orgName: orgName,
          productName: productName,
          url: url,
          authorizedIssuingAccounts: [],
          authorizedIssuingContracts: [CONTRACT_NAME],
          isSignedWithActiveKey,
        });

        // verify nft was created OK
        nft = await api.db.findOneInTable('nft', 'nfts', { symbol: symbol });
        if (api.assert(nft !== null, 'error creating NFT')) {
          const finalIsFoilReadOnly = isFoilReadOnly === undefined ? true : isFoilReadOnly;
          const finalIsTypeReadOnly = isTypeReadOnly === undefined ? true : isTypeReadOnly;

          // Edition only gets set once at issuance and never changes, so we
          // can make it read only.
          await api.executeSmartContract('nft', 'addProperty', {
            symbol: symbol,
            name: 'edition',
            type: 'number',
            isReadOnly: true,
            authorizedEditingAccounts: [],
            authorizedEditingContracts: [CONTRACT_NAME],
            isSignedWithActiveKey,
          });

          await api.executeSmartContract('nft', 'addProperty', {
            symbol: symbol,
            name: 'foil',
            type: 'number',
            isReadOnly: finalIsFoilReadOnly,
            authorizedEditingContracts: [CONTRACT_NAME],
            isSignedWithActiveKey,
          });

          await api.executeSmartContract('nft', 'addProperty', {
            symbol: symbol,
            name: 'type',
            type: 'number',
            isReadOnly: finalIsTypeReadOnly,
            authorizedEditingContracts: [CONTRACT_NAME],
            isSignedWithActiveKey,
          });

          // now verify data properties were added OK
          nft = await api.db.findOneInTable('nft', 'nfts', { symbol: symbol });
          const propertyCount = Object.keys(nft.properties).length;
          if (api.assert(propertyCount === 3, 'NFT created but error adding data properties')) {
            await api.executeSmartContract('nft', 'setGroupBy', {
              symbol: symbol,
              properties: ['edition', 'foil', 'type'],
              isSignedWithActiveKey,
            });

            // indicates this contract is responsible for issuance of the NFT
            const newRecord = {
              nft: symbol,
              feePool: '0',
              categoryRO: false,
              rarityRO: false,
              teamRO: false,
              nameRO: false,
              editionMapping: {},
            };
            await api.db.insert('managedNfts', newRecord);

            // finally, verify groupBy was set OK
            nft = await api.db.findOneInTable('nft', 'nfts', { symbol: symbol });
            const groupByCount = nft.groupBy.length;
            if (api.assert(groupByCount === 3, 'NFT created with data properties, but error setting groupBy')) {
              api.emit('createNft', {
                symbol
              });
            }
          }
        }
      }
    }
  }
};

// TODO: refactor this routine
// generate issuance data for a random NFT instance
const generateRandomInstance = (settings, nftSymbol, to) => {
  // each rarity has 10 types of critters
  const type = Math.floor(api.random() * 10) + 1;

  // determine rarity
  let rarity = 0;
  let rarityRoll = Math.floor(api.random() * 1000) + 1;
  if (rarityRoll > 995) { // 0.5% chance of legendary
    rarity = 3;
  } else if (rarityRoll > 900) { // 10% chance of rare or higher
    rarity = 2;
  } else if (rarityRoll > 700) { // 30% of uncommon or higher
    rarity = 1;
  }

  // determine gold foil
  let isGoldFoil = false;
  rarityRoll = Math.floor(api.random() * 100) + 1;
  if (rarityRoll > 95) { // 5% chance of being gold
    isGoldFoil = true;
  }

  const properties = {
    edition: settings.edition,
    foil: 0,
    type: 0,
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

// TODO: finish me
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
      && packs !== undefined && typeof packs === 'number' && Number.isInteger(packs) && packs >= 1 && packs <= MAX_PACKS_AT_ONCE, 'invalid params')) {
    const settings = await api.db.findOne('packs', { symbol: packSymbol, nft: nftSymbol });
    if (api.assert(settings !== null, 'pack does not open this NFT')) {
      // verify user actually has the desired number of packs to open
      const hasEnoughPacks = await verifyTokenBalance(packs, packSymbol, api.sender);
      if (api.assert(hasEnoughPacks, 'you must have enough packs')) {
        const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
        const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
        if (api.assert(nft !== null, 'NFT symbol must exist')
          && api.assert(underManagement !== null, 'NFT not under management')) {
          // verify this contract has enough in the fee pool to pay the NFT issuance fees
          const numNfts = packs * settings.cardsPerPack;
          const nftParams = await api.db.findOneInTable('nft', 'params', {});
          const { nftIssuanceFee } = nftParams;
          const propertyCount = Object.keys(nft.properties).length;
          const oneTokenIssuanceFee = api.BigNumber(nftIssuanceFee[UTILITY_TOKEN_SYMBOL]).multipliedBy(propertyCount + 1);
          const totalIssuanceFee = oneTokenIssuanceFee.multipliedBy(numNfts);
          const canAffordIssuance = api.BigNumber(underManagement.feePool).gte(totalIssuanceFee);
          if (api.assert(canAffordIssuance, 'contract cannot afford issuance')) {
            // burn the pack tokens
            const res = await api.executeSmartContract('tokens', 'transfer', {
              to: 'null', symbol: packSymbol, quantity: packs.toString(), isSignedWithActiveKey,
            });
            if (!api.assert(isTokenTransferVerified(res, api.sender, 'null', packSymbol, packs.toString(), 'transfer'), 'unable to transfer pack tokens')) {
              return false;
            }

            // issue the NFT instances
            for (let i = 0; i < numNfts; i += 1) {
              const instances = [];
              instances.push(generateRandomInstance(settings, api.sender));

              // TODO: break this up into batches
              await api.executeSmartContract('nft', 'issueMultiple', {
                instances,
                isSignedWithActiveKey,
              });
            }
            return true;
          }
        }
      }
    }
  }
  return false;
};
