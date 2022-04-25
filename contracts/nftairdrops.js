/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'nftairdrops';

/* eslint-disable no-template-curly-in-string */
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
const UTILITY_TOKEN_PRECISION = '${CONSTANTS.UTILITY_TOKEN_PRECISION}$';
/* eslint-enable no-template-curly-in-string */

const ALLOWED_TO_TYPES = ['user', 'contract'];
const ALLOWED_FROM_TYPES = ['user', 'contract'];

// BEGIN helper functions

// Basic checks if the provided name is a valid account or contract name.
const isValidAccountName = (name, accountType) => {
  if (!ALLOWED_TO_TYPES.includes(accountType)) {
    return false;
  }
  if (accountType === 'contract') {
    return (api.validator.isAlphanumeric(name) && name.length >= 3 && name.length <= 50);
  }
  return api.isValidAccountName(name);
};

// Compare two arrays and return if they have any duplicate elements.
const arrayHasDuplicates = arr => new Set(arr).size !== arr.length;

// Check if the requested amount of tokens has been transferred to the expected account.
/* eslint-disable-next-line object-curly-newline */
const tokenTransferVerified = ({ transaction, from, fromType, to, toType, quantity }) => {
  const { errors, events } = transaction;
  let eventType = 'transfer';
  if (fromType === 'contract') {
    eventType = 'transferFromContract';
  } else if (toType === 'contract') {
    eventType = 'transferToContract';
  }

  if (errors === undefined
    && events
    && events.find(el => el.contract === 'tokens'
      && el.event === eventType
      && el.data.symbol === UTILITY_TOKEN_SYMBOL
      && el.data.from === from
      && el.data.to === to
      && el.data.quantity === quantity) !== undefined) {
    return true;
  }
  return false;
};

// Check if NFTs have been successfully moved to the new account.
/* eslint-disable-next-line object-curly-newline */
const nftTransferVerified = async ({ symbol, to, toType, ids }) => {
  const newOwnedBy = (toType === 'contract') ? 'c' : 'u';
  const verification = await api.db.findOneInTable('nft', symbol + 'instances', /* eslint-disable-line prefer-template */
    {
      _id: { $in: ids.map(x => api.BigNumber(x).toNumber()) },
      $or: [{
        account: { $ne: to },
      }, {
        ownedBy: { $ne: newOwnedBy },
      }],
    });
  return (verification === null);
};

// Burns the fee and verifies the transaction.
/* eslint-disable-next-line object-curly-newline */
const burnFee = async ({ from, fromType, quantity }) => {
  // Don't need to do anything when fee is 0.
  if (api.BigNumber(quantity).eq(0)) return true;

  let transaction = null;
  if (fromType === 'contract') {
    transaction = await api.transferTokensFromCallingContract(
      'null',
      UTILITY_TOKEN_SYMBOL,
      quantity,
      'user',
    );
  } else {
    transaction = await api.executeSmartContract('tokens', 'transfer', {
      from,
      to: 'null',
      symbol: UTILITY_TOKEN_SYMBOL,
      quantity,
    });
  }
  return tokenTransferVerified({
    transaction,
    from,
    fromType,
    to: 'null',
    toType: 'user',
    quantity,
  });
};

// Transfers the NFTs to the contract and verifies the transactions.
/* eslint-disable-next-line object-curly-newline */
const reserveNFTs = async ({ fromType, symbol, ids, batchSize }) => {
  for (let i = 0, n = ids.length; i < n; i += batchSize) {
    const transfer = await api.executeSmartContract('nft', 'transfer', {
      fromType,
      to: CONTRACT_NAME,
      toType: 'contract',
      nfts: [{ symbol, ids: ids.slice(i, i + batchSize) }],
      isSignedWithActiveKey: true,
    });
    if (transfer.errors !== undefined) return false;
  }
  return nftTransferVerified({
    symbol,
    to: CONTRACT_NAME,
    toType: 'contract',
    ids,
  });
};

/* eslint-disable-next-line object-curly-newline */
const reimburseNFTs = async ({ to, toType, symbol, ids, batchSize }) => {
  const reservedNfts = [];
  for (let i = 0, n = ids.length; i < n; i += 1000) {
    const nftsInContract = await api.db.findInTable('nft', symbol + 'instances', /* eslint-disable-line prefer-template */
      {
        _id: { $in: ids.map(x => api.BigNumber(x).toNumber()) },
        account: CONTRACT_NAME,
        ownedBy: 'c',
      },
      1000,
      i,
      [{ index: '_id', descending: false }]);
    reservedNfts.push(...nftsInContract.map(x => api.BigNumber(x._id).toString())); /* eslint-disable-line no-underscore-dangle */
  }
  for (let i = 0, n = reservedNfts.length; i < n; i += batchSize) {
    await api.executeSmartContract('nft', 'transfer', {
      fromType: 'contract',
      to,
      toType,
      nfts: [{ symbol, ids: reservedNfts.slice(i, i + batchSize) }],
      isSignedWithActiveKey: true,
    });
  }
  return nftTransferVerified({
    symbol,
    to,
    toType,
    ids: reservedNfts,
  });
};

/* eslint-disable-next-line object-curly-newline */
const parseAndValidateAirdrop = async ({ symbol, sender, senderType, list, startBlockNumber = undefined, softFail = true, params }) => {
  const instanceTableName = symbol + 'instances'; /* eslint-disable-line prefer-template */

  const airdrop = {
    isValid: false,
    softFail: softFail !== false,
    blockNumber: startBlockNumber || api.blockNumber + 1,
    airdropId: api.transactionId,
    symbol,
    from: sender,
    fromType: senderType,
    list,
    nftIds: [],

    totalFee: null,
  };

  // Check if fromType is allowed.
  if (api.assert(params.enabledFromTypes.includes(senderType), 'invalid fromType')) {
    // Check if symbol exists in db.
    if (api.assert(
      typeof symbol === 'string'
      && api.validator.isAlpha(symbol)
      && api.validator.isUppercase(symbol)
      && symbol.length > 0
      && await api.db.findOneInTable('nft', 'nfts', { symbol }) !== null,
      'invalid symbol',
    )) {
      // Validate list of airdrops.
      if (api.assert(
        Array.isArray(list)
        && list.length > 0
        && api.assert(list.length <= params.maxTransactionsPerAirdrop, 'exceeded airdrop transactions limit') // Don't even bother if the list is already too long.
        && list.every((element, index) => {
          if (typeof element === 'object') {
            const { to, ids } = element;
            const toType = element.toType || 'user';

            if (api.assert(isValidAccountName(to, toType), `invalid account ${to} at index ${index}`)
              && api.assert(Array.isArray(ids) && ids.length > 0 && ids.length <= params.maxTransactionsPerAccount && ids.every(i => (typeof i === 'string' && api.BigNumber(i).gt(0))), `invalid nft ids array for account ${to} at index ${index}`)
              && api.assert(airdrop.nftIds.length < params.maxTransactionsPerAirdrop, 'exceeded airdrop transactions limit')) {
              airdrop.nftIds.push(...ids);
              return true;
            }
          }
          return false;
        }),
        'invalid list',
      )) {
        if (api.assert(!arrayHasDuplicates(airdrop.nftIds), 'airdrop list contains duplicate nfts')) {
          // Check NFT delegation and ownership. We can do this in a single query.
          const ownedByType = (senderType === 'contract') ? 'c' : 'u';
          const result = await api.db.findOneInTable('nft', instanceTableName,
            {
              _id: { $in: airdrop.nftIds.map(x => api.BigNumber(x).toNumber()) },
              $or: [{
                account: { $ne: sender },
              }, {
                ownedBy: { $ne: ownedByType },
              }, {
                delegatedTo: { $exists: true },
              }],
            });
          if (api.assert(result === null, 'cannot airdrop nfts that are delegated or not owned by this account')) {
            // blockNumber shall be greater than the current block number.
            if (api.assert(Number.isInteger(airdrop.blockNumber) && airdrop.blockNumber > api.blockNumber, 'invalid startBlockNumber')) {
              airdrop.totalFee = api.BigNumber(params.feePerTransaction).times(airdrop.nftIds.length).toFixed(UTILITY_TOKEN_PRECISION);
              airdrop.isValid = true;
            }
          }
        }
      }
    }
  }

  return airdrop;
};

const processAirdrop = async (airdrop, batchSize) => {
  const {
    softFail,
    symbol,
    list,
    nftIds,
  } = airdrop;

  const processed = [];
  const failed = [];
  // We iterate the list in reverse so it's more easy to modify it in-place.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const { to, toType, ids } = list.pop();
    // Make sure we don't exceed the batch size for a single item.
    const batch = ids.splice(0, batchSize - processed.length);
    // This item still has more transfers pending. Add it back to the list.
    if (ids.length > 0) list.push({ to, toType, ids });

    if (batch.length > 0) {
      const transfer = await api.executeSmartContract('nft', 'transfer', {
        fromType: 'contract',
        to,
        toType,
        nfts: [{ symbol, ids: batch }],
        isSignedWithActiveKey: true,
      });
      if (transfer.errors !== undefined) {
        const success = (transfer.events) ? transfer.events.map(x => x.data.id) : [];
        failed.push(...batch.filter(x => !success.includes(x)));
      }
      if (failed.length > 0 && softFail !== true) {
        // We have errors and the initiator has requested a 'hard fail'.
        airdrop.isValid = false; /* eslint-disable-line no-param-reassign */
        break;
      }
    }

    // Add batch to the processed items. If batch size is reached, stop further processing.
    if (processed.push(...batch) >= batchSize) break;
  }

  // If we've processed everything from the list, mark the airdrop for cleanup and removal from db.
  if (list.length === 0) airdrop.isValid = false; /* eslint-disable-line no-param-reassign */

  // Remove successfully processed NFTs from the nftIds array. We use splice here to modify the nftIds array in-place.
  nftIds.splice(0, nftIds.length, ...nftIds.filter(x => failed.includes(x) || !processed.includes(x)));

  return processed.length;
};

// END helper functions

// BEGIN contract actions

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pendingAirdrops');
  if (tableExists === false) {
    await api.db.createTable('pendingAirdrops', ['airdropId', 'symbol']);
    await api.db.createTable('params');

    const params = {};
    params.feePerTransaction = '0.1';
    params.maxTransactionsPerAirdrop = 50000;
    params.maxTransactionsPerAccount = 50;
    params.maxTransactionsPerBlock = 50;
    params.maxAirdropsPerBlock = 1;
    params.processingBatchSize = 50;
    params.enabledFromTypes = ['user'];
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      feePerTransaction,
      maxTransactionsPerAirdrop,
      maxTransactionsPerAccount,
      maxTransactionsPerBlock,
      maxAirdropsPerBlock,
      processingBatchSize,
      enabledFromTypes,
    } = payload;

    const params = await api.db.findOne('params', {});

    if (feePerTransaction !== undefined) {
      if (api.assert(typeof feePerTransaction === 'string' && !api.BigNumber(feePerTransaction).isNaN() && api.BigNumber(feePerTransaction).gte(0), 'invalid feePerTransaction')) {
        params.feePerTransaction = feePerTransaction;
      }
    }
    if (maxTransactionsPerAirdrop !== undefined) {
      if (api.assert(Number.isInteger(maxTransactionsPerAirdrop) && maxTransactionsPerAirdrop > 0, 'invalid maxTransactionsPerAirdrop')) {
        params.maxTransactionsPerAirdrop = maxTransactionsPerAirdrop;
      }
    }
    if (maxTransactionsPerAccount !== undefined) {
      if (api.assert(Number.isInteger(maxTransactionsPerAccount) && maxTransactionsPerAccount > 0 && maxTransactionsPerAccount <= params.maxTransactionsPerAirdrop, 'invalid maxTransactionsPerAccount')) {
        params.maxTransactionsPerAccount = maxTransactionsPerAccount;
      }
    }
    if (maxTransactionsPerBlock !== undefined) {
      if (api.assert(Number.isInteger(maxTransactionsPerBlock) && maxTransactionsPerBlock > 0, 'invalid maxTransactionsPerBlock')) {
        params.maxTransactionsPerBlock = maxTransactionsPerBlock;
      }
    }
    if (maxAirdropsPerBlock !== undefined) {
      if (api.assert(Number.isInteger(maxAirdropsPerBlock) && maxAirdropsPerBlock > 0, 'invalid maxAirdropsPerBlock')) {
        params.maxAirdropsPerBlock = maxAirdropsPerBlock;
      }
    }
    if (processingBatchSize !== undefined) {
      if (api.assert(Number.isInteger(processingBatchSize) && processingBatchSize > 0, 'invalid processingBatchSize')) {
        params.processingBatchSize = processingBatchSize;
      }
    }
    if (enabledFromTypes !== undefined) {
      if (api.assert(Array.isArray(enabledFromTypes) && enabledFromTypes.length > 0 && enabledFromTypes.every(x => ALLOWED_FROM_TYPES.includes(x)), 'invalid enabledFromTypes')) {
        params.enabledFromTypes = Array.from(new Set(enabledFromTypes));
      }
    }

    await api.db.update('params', params);

    delete params._id; /* eslint-disable-line no-underscore-dangle */
    api.emit('paramsUpdated', params);
  }
};

actions.newAirdrop = async (payload) => {
  const {
    symbol,
    list,
    startBlockNumber,
    softFail,
    fromType,
    isSignedWithActiveKey,
    callingContractInfo,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) {
    const senderType = (callingContractInfo === undefined || fromType !== 'contract') ? 'user' : 'contract';
    const sender = (senderType === 'user') ? api.sender : callingContractInfo.name;
    const params = await api.db.findOne('params', {});
    const airdrop = await parseAndValidateAirdrop({
      symbol, sender, senderType, list, startBlockNumber, softFail, params,
    });

    if (airdrop.isValid) {
      // Airdrop data is valid, reserve the fee.
      const tokensTable = (senderType === 'contract') ? 'contractsBalances' : 'balances';
      const utilityToken = await api.db.findOneInTable('tokens', tokensTable, {
        account: sender,
        symbol: UTILITY_TOKEN_SYMBOL,
      });
      if (api.assert(utilityToken && api.BigNumber(utilityToken.balance).gte(airdrop.totalFee), 'you must have enough tokens to cover the airdrop fee')) {
        if (api.assert(await burnFee({
          from: sender,
          fromType: senderType,
          quantity: airdrop.totalFee,
        }), 'could not secure airdrop fee')) {
          // Fee has been burned, transfer NFTs to the contract.
          if (api.assert(await reserveNFTs({
            fromType: senderType,
            symbol,
            ids: airdrop.nftIds,
            batchSize: params.processingBatchSize,
          }), 'could not secure NFTs')) {
            // Add airdrop to db to start the process.
            await api.db.insert('pendingAirdrops', airdrop);
            api.emit('newNftAirdrop', {
              airdropId: airdrop.airdropId,
              sender,
              senderType,
              symbol,
              startBlockNumber: airdrop.blockNumber,
            });
            return true;
          }
          // Somehow could not initiate airdrop. Return any reserved NFTs to the sender.
          await reimburseNFTs({
            to: sender,
            toType: senderType,
            symbol,
            ids: airdrop.nftIds,
            batchSize: params.processingBatchSize,
          });
        }
      }
    }
  }
  return false;
};

actions.tick = async () => {
  if (api.assert(api.sender === 'null', `not authorized: ${api.sender}`)) {
    const params = await api.db.findOne('params', {});
    const pendingAirdrops = await api.db.find('pendingAirdrops',
      {
        blockNumber: { $lte: api.blockNumber },
      },
      params.maxAirdropsPerBlock,
      0,
      [{ index: '_id', descending: false }]);

    if (pendingAirdrops.length > 0) {
      const batchSize = Math.floor(params.maxTransactionsPerBlock / pendingAirdrops.length);
      for (let i = 0, n = pendingAirdrops.length; i < n; i += 1) {
        const airdrop = pendingAirdrops[i];
        const nftsProcessed = await processAirdrop(airdrop, batchSize);
        api.emit('nftAirdropDistribution', {
          airdropId: airdrop.airdropId,
          symbol: airdrop.symbol,
          transactionCount: nftsProcessed,
        });
        if (airdrop.isValid === true) {
          await api.db.update('pendingAirdrops', airdrop);
        } else {
          await api.db.remove('pendingAirdrops', airdrop);
          // Send remaining locked NFTs, if any, back to the previous owner.
          await reimburseNFTs({
            to: airdrop.from,
            toType: airdrop.fromType,
            symbol: airdrop.symbol,
            ids: airdrop.nftIds,
            batchSize: params.processingBatchSize,
          });
          if (airdrop.softFail === false && airdrop.nftIds.length > 0) {
            api.emit('nftAirdropFailed', {
              airdropId: airdrop.airdropId,
              symbol: airdrop.symbol,
            });
          } else {
            api.emit('nftAirdropFinished', {
              airdropId: airdrop.airdropId,
              symbol: airdrop.symbol,
            });
          }
        }
      }
    }
  }
};

// END contract actions
