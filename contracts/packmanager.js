/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'packmanager';

// BEE tokens on Hive Engine, ENG on Steem Engine, and SSC on the testnet
const UTILITY_TOKEN_SYMBOL = 'BEE';

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

const verifyUtilityTokenBalance = async (amount, account) => {
  if (api.BigNumber(amount).lte(0)) {
    return true;
  }
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account, symbol: UTILITY_TOKEN_SYMBOL });
  if (utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(amount)) {
    return true;
  }
  return false;
};

const burnFee = async (amount, isSignedWithActiveKey) => {
  if (api.BigNumber(amount).gt(0)) {
    const res = await api.executeSmartContract('tokens', 'transfer', {
      to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: amount, isSignedWithActiveKey,
    });
    // check if the tokens were sent
    if (!isTokenTransferVerified(res, api.sender, 'null', UTILITY_TOKEN_SYMBOL, amount, 'transfer')) {
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

// TODO: add other creation settings
actions.updateSettings = async (payload) => {
  const {
    packSymbol,
    nftSymbol,
    edition,
    isSignedWithActiveKey,
  } = payload;

  // nothing to do if there's not at least one field to update
  if (edition === undefined) {
    return false;
  }

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(packSymbol && typeof packSymbol === 'string'
      && nftSymbol && typeof nftSymbol === 'string'
      && (edition === undefined || (typeof edition === 'number' && Number.isInteger(edition) && edition >= 0)), 'invalid params')) {
    const settings = await api.db.findOne('packs', { symbol: packSymbol, nft: nftSymbol });
    if (api.assert(settings !== null, 'pack not registered for this NFT')) {
      if (api.assert(settings.account === api.sender, 'not authorized to update settings')) {
        const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
        if (api.assert(nft !== null, 'NFT symbol must exist')
          && api.assert(nft.circulatingSupply === 0, 'NFT instances must not be in circulation')) {
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
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(packSymbol && typeof packSymbol === 'string'
      && nftSymbol && typeof nftSymbol === 'string'
      && edition !== undefined && typeof edition === 'number' && Number.isInteger(edition) && edition >= 0, 'invalid params')) {
    // make sure registration fee can be paid
    const params = await api.db.findOne('params', {});
    const hasEnoughBalance = await verifyUtilityTokenBalance(params.registerFee, api.sender);

    if (api.assert(hasEnoughBalance, 'you must have enough tokens to cover the registration fee')) {
      // verify pack & NFT symbols exist, and NFT was created through this contract
      const packToken = await api.db.findOneInTable('tokens', 'tokens', { symbol: packSymbol });
      if (api.assert(packToken !== null, 'pack symbol must exist')) {
        const underManagement = await api.db.findOne('managedNfts', { nft: nftSymbol });
        if (api.assert(underManagement !== null, `NFT not created through ${CONTRACT_NAME}`)) {
          const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: nftSymbol });
          if (api.assert(nft !== null, 'NFT symbol must exist')
            && api.assert(nft.issuer === api.sender, 'not authorized to register')
            && api.assert(nft.circulatingSupply === 0, 'unable to register; NFT instances already issued')) {
            // make sure this pack / NFT combo  hasn't been registered yet
            const settings = await api.db.findOne('packs', { symbol: packSymbol, nft: nftSymbol });
            if (api.assert(settings === null, `pack already registered for ${nftSymbol}`)) {
              // burn the registration fee
              if (!(await burnFee(params.registerFee, isSignedWithActiveKey))) {
                return false;
              }

              const newSettings = {
                account: api.sender,
                symbol: packSymbol,
                nft: nftSymbol,
                edition: edition,
              };

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
    const hasEnoughBalance = await verifyUtilityTokenBalance(nftCreationFee, api.sender);

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
            const newRecord = { nft: symbol };
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

// generate issuance data for a random critter of the given edition
const generateRandomCritter = (edition, to) => {
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
    edition,
    type,
    rarity,
    isGoldFoil,
    name: '',
    xp: 0,
    hp: 100,
  };

  const instance = {
    symbol: 'CRITTER',
    fromType: 'contract',
    to,
    feeSymbol: UTILITY_TOKEN_SYMBOL,
    properties,
  };

  return instance;
};

// open some packs
// TODO: when opening, need to specify both a pack symbol and nft symbol
actions.open = async (payload) => {
  // this action requires active key authorization
  const {
    packSymbol, // the token we want to buy with determines which edition to issue
    packs, // how many critters to hatch (1 pack = 5 critters)
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { editionMapping } = params;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(packSymbol && typeof packSymbol === 'string' && packSymbol in editionMapping, 'invalid pack symbol')
    && api.assert(packs && typeof packs === 'number' && packs >= 1 && packs <= 10 && Number.isInteger(packs), 'packs must be an integer between 1 and 10')) {
    // verify user has enough balance to pay for all the packs
    const paymentTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: packSymbol });
    const authorized = paymentTokenBalance && api.BigNumber(paymentTokenBalance.balance).gte(packs);
    if (api.assert(authorized, 'you must have enough pack tokens')) {
      // verify this contract has enough balance to pay the NFT issuance fees
      const crittersToHatch = packs * CRITTERS_PER_PACK;
      const nftParams = await api.db.findOneInTable('nft', 'params', {});
      const { nftIssuanceFee } = nftParams;
      const oneTokenIssuanceFee = api.BigNumber(nftIssuanceFee[UTILITY_TOKEN_SYMBOL]).multipliedBy(8); // base fee + 7 data properties
      const totalIssuanceFee = oneTokenIssuanceFee.multipliedBy(crittersToHatch);
      const utilityTokenBalance = await api.db.findOneInTable('tokens', 'contractsBalances', { account: CONTRACT_NAME, symbol: UTILITY_TOKEN_SYMBOL });
      const canAffordIssuance = utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(totalIssuanceFee);
      if (api.assert(canAffordIssuance, 'contract cannot afford issuance')) {
        // burn the pack tokens
        const res = await api.executeSmartContract('tokens', 'transfer', {
          to: 'null', symbol: packSymbol, quantity: packs.toString(), isSignedWithActiveKey,
        });
        if (!api.assert(isTokenTransferVerified(res, api.sender, 'null', packSymbol, packs.toString(), 'transfer'), 'unable to transfer pack tokens')) {
          return false;
        }

        // we will issue critters in packs of 5 at once
        for (let i = 0; i < packs; i += 1) {
          const instances = [];
          for (let j = 0; j < CRITTERS_PER_PACK; j += 1) {
            instances.push(generateRandomCritter(editionMapping[packSymbol], api.sender));
          }

          await api.executeSmartContract('nft', 'issueMultiple', {
            instances,
            isSignedWithActiveKey,
          });
        }
        return true;
      }
    }
  }
  return false;
};
