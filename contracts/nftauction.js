/* global actions, api */

const UTILITY_TOKEN_SYMBOL = 'BEE';
const MAX_NUM_UNITS_OPERABLE = 50;

const CONTRACT_NAME = 'nftauction';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('auctions');
  if (tableExists === false) {
    await api.db.createTable('auctions', ['auctionId', 'symbol']);
    await api.db.createTable('params');

    const params = {};
    // fee required to set up an auction
    params.creationFee = '1';
    // percent a bid needs to increase to take the lead
    params.minBidIncrement = 5;
    // time remaining in the auction settling when cancel action is locked
    params.cancelLockTime = 60000; // 5 mins
    // time after the currentLead bid it takes to settle the auction
    params.expiryTime = 86400000; // 24 hours
    // max time an auction can run
    params.maxExpiryTime = 2592000000; // 30 days
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      creationFee,
      minBidIncrement,
      cancelLockTime,
      expiryTime,
      maxExpiryTime,
    } = payload;

    const params = await api.db.findOne('params', {});

    if (creationFee) {
      if (!api.assert(typeof creationFee === 'string' && !api.BigNumber(creationFee).isNaN() && api.BigNumber(creationFee).gte(0), 'invalid creationFee')) return;
      params.creationFee = creationFee;
    }
    if (minBidIncrement) {
      if (!api.assert(Number.isInteger(minBidIncrement) && minBidIncrement > 0, 'invalid minBidIncrement')) return;
      params.minBidIncrement = minBidIncrement;
    }
    if (cancelLockTime) {
      if (!api.assert(Number.isInteger(cancelLockTime) && cancelLockTime > 0, 'invalid cancelLockTime')) return;
      params.cancelLockTime = cancelLockTime;
    }
    if (expiryTime) {
      if (!api.assert(Number.isInteger(expiryTime) && expiryTime > 0, 'invalid expiryTime')) return;
      params.expiryTime = expiryTime;
    }
    if (maxExpiryTime) {
      if (!api.assert(Number.isInteger(maxExpiryTime) && maxExpiryTime > 0, 'invalid maxExpiryTime')) return;
      params.maxExpiryTime = maxExpiryTime;
    }

    await api.db.update('params', params);
  }
};

const countDecimals = value => api.BigNumber(value).dp();

const getTimestamp = (value) => {
  try {
    const date = new Date(`${value}.00Z`);
    return date.getTime();
  } catch (e) {
    return false;
  }
};

const transferIsSuccessful = (result, action, from, to, symbol, quantity) => {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens'
    && el.event === action
    && el.data.from === from
    && el.data.to === to
    && api.BigNumber(el.data.quantity).eq(quantity)
    && el.data.symbol === symbol) !== undefined) {
    return true;
  }

  return false;
};

actions.create = async (payload) => {
  const {
    symbol,
    nfts,
    minBid,
    finalPrice,
    priceSymbol,
    expiry,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid symbol')) return;

  const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(nfts && typeof nfts === 'object' && Array.isArray(nfts)
      && minBid && typeof minBid === 'string' && !api.BigNumber(minBid).isNaN()
      && finalPrice && typeof finalPrice === 'string' && !api.BigNumber(finalPrice).isNaN()
      && priceSymbol && typeof priceSymbol === 'string'
      && expiry && typeof expiry === 'string', 'invalid params')
    && api.assert(nfts.length <= MAX_NUM_UNITS_OPERABLE, `cannot process more than ${MAX_NUM_UNITS_OPERABLE} NFT instances at once`)
    && api.assert(nft, 'NFT symbol does not exist')) {
    // get the price token params
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
    const params = await api.db.findOne('params', {});

    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();
    const expiryTimestamp = getTimestamp(expiry);
    const maxExpiryTimestamp = api.BigNumber(timestamp)
      .plus(params.maxExpiryTime).toNumber();

    if (api.assert(token, 'priceSymbol does not exist')
      // minBid checks
      && api.assert(api.BigNumber(minBid).gt(0)
        && countDecimals(minBid) <= token.precision, 'invalid minBid')
      // finalPrice checks
      && api.assert(api.BigNumber(finalPrice).gt(0)
        && countDecimals(finalPrice) <= token.precision, 'invalid finalPrice')
      // expiry checks
      && api.assert(expiryTimestamp && expiryTimestamp > timestamp, 'invalid expiry')
      && api.assert(expiryTimestamp <= maxExpiryTimestamp, 'expiry exceeds limit')) {
      const utilityToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });

      if (api.assert(utilityToken && utilityToken.balance
        && api.BigNumber(utilityToken.balance).gte(params.creationFee), 'you must have enough tokens to cover the creation fee')) {
        // lock the NFTs to sell by moving them to this contract for safekeeping
        const wrappedNfts = {
          symbol,
          ids: nfts,
        };
        const nftTransfer = await api.executeSmartContract('nft', 'transfer', {
          fromType: 'user',
          to: CONTRACT_NAME,
          toType: 'contract',
          nfts: [wrappedNfts],
          isSignedWithActiveKey,
        });

        // only add nfts in the auction which transfered successfully
        if (api.assert(nftTransfer.events, 'failed to trasfer NFTs to the contract')) {
          const nftIds = [];

          for (let i = 0; i < nftTransfer.events.length; i += 1) {
            const ev = nftTransfer.events[i];
            if (ev.contract && ev.event && ev.data
              && ev.contract === 'nft'
              && ev.event === 'transfer'
              && ev.data.from === api.sender
              && ev.data.fromType === 'u'
              && ev.data.to === CONTRACT_NAME
              && ev.data.toType === 'c'
              && ev.data.symbol === symbol) {
              // transfer is verified
              const instanceId = ev.data.id;
              nftIds.push(instanceId);
            }
          }

          if (nftIds.length > 0) {
            const feeTransfer = await api.executeSmartContract('tokens', 'transfer', {
              to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: params.creationFee, isSignedWithActiveKey,
            });

            if (transferIsSuccessful(feeTransfer, 'transfer', api.sender, 'null', UTILITY_TOKEN_SYMBOL, params.creationFee)) {
              // create an auction
              const auction = {
                auctionId: api.transactionId,
                symbol,
                nftIds,
                minBid,
                finalPrice,
                expiryTimestamp,
                bids: [],
                currentLead: null,
              };

              const res = await api.db.insert('auctions', auction);

              api.emit('create', { auctionId: res.auctionId });
            } else {
              // if fee transfer somehow fails, return the transfered NFTs
              wrappedNfts.ids = nftIds;
              await api.executeSmartContract('nft', 'transfer', {
                fromType: 'contract',
                to: api.sender,
                toType: 'user',
                nfts: [wrappedNfts],
                isSignedWithActiveKey,
              });
            }
          }
        }
      }
    }
  }
};
