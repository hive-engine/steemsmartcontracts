/* eslint-disable no-await-in-loop */
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
    params.minBidIncrement = 50; // 5%

    // time remaining in the auction settling when cancel action is locked
    params.cancelLockTime = 60000; // 5 mins

    // time after the last lead bid it takes to settle the auction
    params.expiryTime = 86400000; // 24 hours

    // max time an auction can run
    params.maxExpiryTime = 2592000000; // 30 days

    // max auctions to settle per block
    params.auctionsPerBlock = 2;
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
      auctionsPerBlock,
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
    if (auctionsPerBlock) {
      if (!api.assert(Number.isInteger(auctionsPerBlock) && auctionsPerBlock > 0, 'invalid auctionsPerBlock')) return;
      params.auctionsPerBlock = auctionsPerBlock;
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

const settleAuction = async (auction, id = null) => {
  const {
    auctionId,
    symbol,
    seller,
    nftIds,
    priceSymbol,
    bids,
    currentLead,
  } = auction;

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();

  const wrappedNfts = {
    symbol,
    ids: nftIds,
  };

  if (bids.length > 0) {
    const bidId = id === null ? currentLead : id;
    const leadBid = bids[bidId];
    bids.splice(bidId, 1);

    // send payment to the seller
    await api.transferTokens(seller, priceSymbol, leadBid.bid, 'user');

    let count = 0;

    while (count < bids.length) {
      const {
        account,
        bid,
      } = bids[count];

      // send tokens back to bidders
      await api.transferTokens(account, priceSymbol, bid, 'user');
      count += 1;
    }

    // transfer the NFTs to the buyer
    await api.executeSmartContract('nft', 'transfer', {
      fromType: 'contract',
      to: leadBid.account,
      toType: 'user',
      nfts: [wrappedNfts],
      isSignedWithActiveKey: true,
    });

    await api.db.remove('auctions', auction);

    api.emit('settleAuction', {
      auctionId,
      symbol,
      seller,
      nftIds,
      bidder: leadBid.account,
      price: leadBid.bid,
      priceSymbol,
      timestamp,
    });
  } else {
    // if there are no bids, expire the auction
    await api.db.remove('auctions', auction);

    // return the NFTs to the seller
    await api.executeSmartContract('nft', 'transfer', {
      fromType: 'contract',
      to: seller,
      toType: 'user',
      nfts: [wrappedNfts],
      isSignedWithActiveKey: true,
    });

    api.emit('expireAuction', {
      auctionId,
      symbol,
      seller,
      nftIds,
      timestamp,
    });
  }
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
                seller: api.sender,
                nftIds,
                priceSymbol,
                minBid,
                finalPrice,
                expiryTimestamp,
                bids: [],
                currentLead: null,
                lastLeadUpdate: timestamp,
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

actions.bid = async (payload) => {
  const {
    auctionId,
    bid,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(auctionId && typeof auctionId === 'string'
      && bid && typeof bid === 'string' && !api.BigNumber(bid).isNaN(), 'invalid params')) {
    const auction = await api.db.findOne('auctions', { auctionId });

    if (api.assert(auction, 'auction does not exist or has been expired')) {
      const {
        priceSymbol,
        minBid,
        finalPrice,
        currentLead,
        expiryTimestamp,
      } = auction;
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
      const params = await api.db.findOne('params', {});
      const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
      const timestamp = blockDate.getTime();

      if (api.assert(api.BigNumber(bid).gt(0)
          && countDecimals(bid) <= token.precision, 'invalid bid')
        && api.assert(api.BigNumber(bid).gte(minBid), `bid can not be less than ${minBid}`)
        && api.assert(expiryTimestamp >= timestamp, 'auction has been expired')) {
        let nbTokensToLock = api.BigNumber(bid).gt(finalPrice) ? finalPrice : bid;
        // find if the account has any previous bid in this auction
        const previousBidIndex = auction.bids.findIndex(el => el.account === api.sender);
        const previousBid = auction.bids[previousBidIndex];

        const newBid = {
          account: api.sender,
          bid: nbTokensToLock,
          timestamp,
        };

        if (previousBid) {
          if (!api.assert(api.BigNumber(nbTokensToLock).gt(previousBid.bid), 'bid must be greater than your previous bid')) return;
          // update the previous bid
          auction.bids[previousBidIndex] = newBid;
          // lock only tokens that exceed the previous bid quantity
          nbTokensToLock = api.BigNumber(nbTokensToLock)
            .minus(previousBid.bid)
            .toFixed(token.precision);
        } else {
          auction.bids.push(newBid);
        }

        const priceToken = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: priceSymbol });

        if (api.assert(priceToken && priceToken.balance
          && api.BigNumber(priceToken.balance).gte(nbTokensToLock), 'insufficient balance for this bid')) {
          // lock the bid in the contract for safe keeping
          const tokenTransfer = await api.executeSmartContract('tokens', 'transferToContract', {
            to: CONTRACT_NAME, symbol: priceSymbol, quantity: nbTokensToLock,
          });

          // make sure the transfer was succesfull and update auction
          if (transferIsSuccessful(tokenTransfer, 'transferToContract', api.sender, CONTRACT_NAME, priceSymbol, nbTokensToLock)) {
            const newBidIndex = auction.bids.findIndex(el => el.account === api.sender);

            // if the bid hits the finalPrice, settle the auction
            if (api.BigNumber(newBid.bid).gte(finalPrice)) {
              auction.currentLead = newBidIndex;
              await settleAuction(auction);
              return;
            }

            if (currentLead !== null) {
              // check if new bid takes the lead
              const leadBid = auction.bids[currentLead];
              const minBidIncrementPct = params.minBidIncrement / 1000;
              // quantity increment the new bid requires to take the lead
              const minBidIncrement = api.BigNumber(leadBid.bid)
                .multipliedBy(minBidIncrementPct)
                .toFixed(token.precision);

              if (api.BigNumber(newBid.bid).minus(leadBid.bid).gte(minBidIncrement)) {
                // change the lead to this new bid
                auction.currentLead = newBidIndex;
                auction.lastLeadUpdate = timestamp;
              }
            } else {
              auction.currentLead = newBidIndex;
              auction.lastLeadUpdate = timestamp;
            }

            await api.db.update('auctions', auction);

            if (previousBid) {
              api.emit('updateBid', {
                auctionId,
                account: newBid.account,
                oldBid: previousBid.bid,
                newBid: newBid.bid,
                oldTimestamp: previousBid.timestamp,
                newTimestamp: newBid.timestamp,
              });
            } else {
              api.emit('bid', {
                auctionId,
                ...newBid,
              });
            }
          }
        }
      }
    }
  }
};

actions.updateAuctions = async () => {
  if (!api.assert(api.sender === 'null', 'not authorized')) return;

  const params = await api.db.findOne('params', {});

  const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
  const timestamp = blockDate.getTime();

  const lastValidLead = timestamp - params.expiryTime;

  const auctionsToSettle = await api.db.find('auctions',
    {
      $or: [
        { lastLeadUpdate: { $lte: lastValidLead } },
        { expiryTimestamp: { $lte: timestamp } },
      ],
    },
    params.auctionsPerBlock,
    0,
    [{ index: '_id', descending: false }]);

  for (let i = 0; i < auctionsToSettle.length; i += 1) {
    const auction = auctionsToSettle[i];
    settleAuction(auction);
  }
};
