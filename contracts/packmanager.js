/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'packmanager';

// BEE tokens on Hive Engine, ENG on Steem Engine, and SSC on the testnet
const UTILITY_TOKEN_SYMBOL = 'BEE';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('packs');
  if (tableExists === false) {
    await api.db.createTable('packs', ['symbol', 'nft']);
    await api.db.createTable('params');

    const params = {};
    params.registerFee = '1000';
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
  } = payload;

  const params = await api.db.findOne('params', {});

  if (registerFee && typeof registerFee === 'string' && !api.BigNumber(registerFee).isNaN() && api.BigNumber(registerFee).gte(0)) {
    params.registerFee = registerFee;
  }

  await api.db.update('params', params);
};

actions.createNft = async (payload) => {
  const {
    name,
    orgName,
    productName,
    symbol,
    url,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) {
    // calculate NFT creation costs based on contract params
    const nftParams = await api.db.findOneInTable('nft', 'params', {});
    const {
      nftCreationFee,
      dataPropertyCreationFee,
    } = nftParams;
    const propertyFee = api.BigNumber(dataPropertyCreationFee).multipliedBy(1); // first 3 data properties are free
    const totalFeeAmount = api.BigNumber(nftCreationFee).plus(propertyFee);
  }

  // verify CRITTER does not exist yet
  const nft = await api.db.findOneInTable('nft', 'nfts', { symbol: 'CRITTER' });
  if (api.assert(nft === null, 'CRITTER already exists')
    && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) {
    // create CRITTER
    // Note 1: we don't specify maxSupply, which means the supply of CRITTER
    // will be unlimited. But indirectly the supply is limited by the
    // supply of the tokens you can use to buy CRITTERS.
    // Note 2: we want this contract to be the only authorized token issuer
    await api.executeSmartContract('nft', 'create', {
      name: 'Mischievous Crypto Critters',
      symbol: 'CRITTER',
      authorizedIssuingAccounts: [],
      authorizedIssuingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // Now add some data properties (note that only this contract is
    // authorized to edit data properties). We could have chosen a more
    // economical design by formatting these in some custom way to fit
    // within a single string data property, which would cut down on
    // token issuance fees. The drawback is then we lose the ability to
    // easily query tokens by properties (for example, get a list of all
    // rare critters or all critters belonging to a certain edition, etc).

    // Edition only gets set once at issuance and never changes, so we
    // can make it read only.
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'edition',
      type: 'number',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // Type (which also never changes once set) represents the kind of
    // critter within an edition. The interpretation of this value is
    // handled by whatever app uses these tokens; for example maybe
    // 0 = dragon, 1 = troll, 2 = goblin, etc
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'type',
      type: 'number',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // How rare is this critter? 0 = common, 1 = uncommon,
    // 2 = rare, 3 = legendary
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'rarity',
      type: 'number',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });

    // Do we have a super rare gold foil?
    await api.executeSmartContract('nft', 'addProperty', {
      symbol: 'CRITTER',
      name: 'isGoldFoil',
      type: 'boolean',
      isReadOnly: true,
      authorizedEditingAccounts: [],
      authorizedEditingContracts: [CONTRACT_NAME],
      isSignedWithActiveKey,
    });
  }
};

// This action can be called by a token holder to change
// their critter's name.
actions.updateName = async (payload) => {
  const { id, name } = payload;

  if (api.assert(id && typeof id === 'string'
    && !api.BigNumber(id).isNaN() && api.BigNumber(id).gt(0)
    && name && typeof name === 'string', 'invalid params')
    && api.assert(api.validator.isAlphanumeric(api.validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 25, 'invalid name: letters, numbers, whitespaces only, max length of 25')) {
    // fetch the token we want to edit
    const instance = await api.db.findOneInTable('nft', 'CRITTERinstances', { _id: api.BigNumber(id).toNumber() });

    if (instance) {
      // make sure this token is owned by the caller
      if (api.assert(instance.account === api.sender && instance.ownedBy === 'u', 'must be the token holder')) {
        await api.executeSmartContract('nft', 'setProperties', {
          symbol: 'CRITTER',
          fromType: 'contract',
          nfts: [{
            id, properties: { name },
          }],
        });
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

// issue some random critters!
actions.hatch = async (payload) => {
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
