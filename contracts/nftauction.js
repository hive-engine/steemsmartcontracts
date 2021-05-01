/* eslint-disable no-await-in-loop */
/* global actions, api */

const UTILITY_TOKEN_SYMBOL = 'BEE';
const MAX_NUM_UNITS_OPERABLE = 50;
const MAX_BID_INCREMENT_PERCENT = 10000;

const CONTRACT_NAME = 'nftauction';

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('auctions');
  if (tableExists === false) {
    await api.db.createTable('auctions', ['auctionId', 'symbol', 'lastValidLead', 'expiryTimestamp']);
    await api.db.createTable('params');
    await api.db.createTable('marketParams', ['symbol']);

    const params = {};
    // fee required to set up an auction
    params.creationFee = '1';

    // percent a bid needs to increase to take the lead
    params.minBidIncrementPercent = 500; // 5%

    // time remaining in the auction settling when cancel action is locked
    params.cancelLockTimeMillis = 300000; // 5 mins

    // time after the last lead bid it takes to settle the auction
    params.expiryTimeMillis = 86400000; // 24 hours

    // max time an auction can run
    params.maxExpiryTimeMillis = 2592000000; // 30 days

    // max auctions to settle per block
    params.auctionsPerBlock = 1;
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.assert(api.sender === api.owner, 'not authorized')) {
    const {
      creationFee,
      minBidIncrementPercent,
      cancelLockTimeMillis,
      expiryTimeMillis,
      maxExpiryTimeMillis,
      auctionsPerBlock,
    } = payload;

    const params = await api.db.findOne('params', {});

    if (creationFee) {
      if (!api.assert(typeof creationFee === 'string' && api.BigNumber(creationFee).isFinite() && api.BigNumber(creationFee).gte(0), 'invalid creationFee')) return;
      params.creationFee = creationFee;
    }
    if (minBidIncrementPercent) {
      if (!api.assert(Number.isInteger(minBidIncrementPercent) && minBidIncrementPercent > 0 && minBidIncrementPercent <= MAX_BID_INCREMENT_PERCENT, 'invalid minBidIncrementPercent')) return;
      params.minBidIncrementPercent = minBidIncrementPercent;
    }
    if (cancelLockTimeMillis) {
      if (!api.assert(Number.isInteger(cancelLockTimeMillis) && cancelLockTimeMillis > 0, 'invalid cancelLockTimeMillis')) return;
      params.cancelLockTimeMillis = cancelLockTimeMillis;
    }
    if (expiryTimeMillis) {
      if (!api.assert(Number.isInteger(expiryTimeMillis) && expiryTimeMillis > 0, 'invalid expiryTimeMillis')) return;
      params.expiryTimeMillis = expiryTimeMillis;
    }
    if (maxExpiryTimeMillis) {
      if (!api.assert(Number.isInteger(maxExpiryTimeMillis) && maxExpiryTimeMillis > 0, 'invalid maxExpiryTimeMillis')) return;
      params.maxExpiryTimeMillis = maxExpiryTimeMillis;
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

const sendNfts = async (to, wrappedNfts) => {
  // transfer NFTs
  await api.executeSmartContract('nft', 'transfer', {
    fromType: 'contract',
    to,
    toType: 'user',
    nfts: [wrappedNfts],
    isSignedWithActiveKey: true,
  });
};

const returnBids = async (bids, priceSymbol) => {
  for (let i = 0; i < bids.length; i += 1) {
    const {
      account,
      bid,
    } = bids[i];

    // send tokens back to bidders
    await api.transferTokens(account, priceSymbol, bid, 'user');
  }
};

const cancelAuction = async (auction) => {
  const {
    auctionId,
    symbol,
    seller,
    nftIds,
    priceSymbol,
    bids,
  } = auction;

  // return all the bids
  await returnBids(bids, priceSymbol);

  const wrappedNfts = {
    symbol,
    ids: nftIds,
  };

  // return NFTs to the seller
  await sendNfts(seller, wrappedNfts);

  // remove auction object from the db
  await api.db.remove('auctions', auction);

  api.emit('cancelAuction', {
    auctionId,
  });
};

const settleAuction = async (auction, index = null) => {
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
    const bidIndex = index === null ? currentLead : index;
    const leadBid = bids[bidIndex];

    // remove the lead bid from the returning bids
    bids.splice(bidIndex, 1);

    // return the bids
    await returnBids(bids, priceSymbol);

    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
    const price = api.BigNumber(leadBid.bid);
    const feePercent = auction.fee / 10000;
    let fee = price.multipliedBy(feePercent).decimalPlaces(token.precision);
    if (fee.gt(price)) {
      fee = price; // unlikely but need to be sure
    }

    let payment = price.minus(fee).decimalPlaces(token.precision);
    if (payment.lt(0)) {
      payment = api.BigNumber(0); // unlikely but need to be sure
    }

    // check if we have to split the fee into market & agent fees
    const marketParams = await api.db.findOne('marketParams', { symbol });
    let agentFee = api.BigNumber(0);
    if (marketParams && marketParams.officialMarket
      && marketParams.agentCut !== undefined
      && marketParams.agentCut > 0 && fee.gt(0)) {
      const agentFeePercent = marketParams.agentCut / 10000;
      agentFee = fee.multipliedBy(agentFeePercent).decimalPlaces(token.precision);
      if (agentFee.gt(fee)) {
        agentFee = api.BigNumber(fee); // unlikely but need to be sure
      }

      fee = fee.minus(agentFee).decimalPlaces(token.precision);
      if (fee.lt(0)) {
        fee = api.BigNumber(0); // unlikely but need to be sure
      }
    }

    // send fee to market account
    const officialMarketAccount = (marketParams && marketParams.officialMarket)
      ? marketParams.officialMarket : leadBid.marketAccount;
    let isMarketFeePaid = false;
    if (fee.gt(0)) {
      isMarketFeePaid = true;
      fee = fee.toFixed(token.precision);
      await api.transferTokens(officialMarketAccount, priceSymbol, fee, 'user');
    }

    // send fee to agent account
    let isAgentFeePaid = false;
    if (agentFee.gt(0)) {
      isAgentFeePaid = true;
      agentFee = agentFee.toFixed(token.precision);
      await api.transferTokens(leadBid.marketAccount, priceSymbol, agentFee, 'user');
    }

    if (payment.gt(0)) {
      // send payment to the seller
      await api.transferTokens(seller, priceSymbol, payment, 'user');
    }

    // send NFTs to the buyer
    await sendNfts(leadBid.account, wrappedNfts);

    await api.db.remove('auctions', auction);

    const ackPacket = {
      auctionId,
      symbol,
      seller,
      nftIds,
      bidder: leadBid.account,
      price: leadBid.bid,
      priceSymbol,
      timestamp,
    };

    if (isMarketFeePaid) {
      ackPacket.marketAccount = officialMarketAccount;
      ackPacket.fee = fee;
    }
    if (isAgentFeePaid) {
      ackPacket.agentAccount = leadBid.marketAccount;
      ackPacket.agentFee = agentFee;
    }

    api.emit('settleAuction', ackPacket);
  } else {
    // if there are no bids, expire the auction
    await api.db.remove('auctions', auction);

    // return NFTs to the seller
    await sendNfts(seller, wrappedNfts);

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
    fee,
    expiry,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid symbol')) return;
  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
  if (!api.assert(nft, 'NFT symbol does not exist')) return;

  if (api.assert(nfts && typeof nfts === 'object' && Array.isArray(nfts)
    && minBid && typeof minBid === 'string' && api.BigNumber(minBid).isFinite()
    && finalPrice && typeof finalPrice === 'string' && api.BigNumber(finalPrice).isFinite()
    && priceSymbol && typeof priceSymbol === 'string'
    && typeof fee === 'number' && fee >= 0 && fee <= 10000 && Number.isInteger(fee)
    && expiry && typeof expiry === 'string', 'invalid params')
    && api.assert(nfts.length <= MAX_NUM_UNITS_OPERABLE, `cannot process more than ${MAX_NUM_UNITS_OPERABLE} NFT instances at once`)) {
    const marketParams = await api.db.findOne('marketParams', { symbol });
    if (marketParams && marketParams.minFee !== undefined) {
      if (!api.assert(fee >= marketParams.minFee, `fee must be >= ${marketParams.minFee}`)) {
        return;
      }
    }

    // get the price token params
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
    const params = await api.db.findOne('params', {});

    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();
    const expiryTimestamp = getTimestamp(expiry);
    const maxExpiryTimestamp = api.BigNumber(timestamp)
      .plus(params.maxExpiryTimeMillis).toNumber();

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
                fee,
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

actions.settle = async (payload) => {
  const {
    auctionId,
    account,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  if (api.assert(auctionId && typeof auctionId === 'string'
    && (!account || (account && typeof account === 'string' && api.isValidAccountName(account))), 'invalid params')) {
    const auction = await api.db.findOne('auctions', { auctionId });

    if (api.assert(auction, 'auction does not exist or has been expired')
      && api.assert(auction.seller === api.sender, 'you must be the owner of the auction')) {
      if (api.assert(auction.bids.length > 0, 'there are no bids in the auction')) {
        let id = auction.currentLead;

        if (account) {
          // search if there is a bid from this account
          id = auction.bids.findIndex(el => el.account === account);
          if (!api.assert(auction.bids[id], 'no bid from account found in the auction')) return;
        }

        await settleAuction(auction, id);
      }
    }
  }
};

actions.cancel = async (payload) => {
  const {
    auctionId,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  if (api.assert(auctionId && typeof auctionId === 'string', 'invalid params')) {
    const auction = await api.db.findOne('auctions', { auctionId });

    if (api.assert(auction, 'auction does not exist or has been expired')
    && api.assert(auction.seller === api.sender, 'you must be the owner of the auction')) {
      await cancelAuction(auction);
    }
  }
};

actions.bid = async (payload) => {
  const {
    auctionId,
    bid,
    marketAccount,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  if (api.assert(auctionId && typeof auctionId === 'string'
    && bid && typeof bid === 'string' && api.BigNumber(bid).isFinite()
    && marketAccount && typeof marketAccount === 'string', 'invalid params')) {
    const auction = await api.db.findOne('auctions', { auctionId });

    if (api.assert(auction, 'auction does not exist or has been expired')) {
      const {
        seller,
        priceSymbol,
        minBid,
        finalPrice,
        currentLead,
        expiryTimestamp,
      } = auction;
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
      const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
      const timestamp = blockDate.getTime();

      if (api.assert(api.sender !== seller, 'auction seller can not bid')
        && api.assert(api.BigNumber(bid).gt(0)
          && countDecimals(bid) <= token.precision, 'invalid bid')
        && api.assert(api.BigNumber(bid).gte(minBid), `bid can not be less than ${minBid}`)
        && api.assert(expiryTimestamp >= timestamp, 'auction has been expired')
        && api.assert(api.isValidAccountName(marketAccount), 'invalid marketAccount')) {
        let nbTokensToLock = api.BigNumber(bid).gt(finalPrice) ? finalPrice : bid;
        // find if the account has any previous bid in this auction
        const previousBidIndex = auction.bids.findIndex(el => el.account === api.sender);
        const previousBid = auction.bids[previousBidIndex];

        const newBid = {
          account: api.sender,
          bid: nbTokensToLock,
          marketAccount,
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

            const params = await api.db.findOne('params', {});

            if (currentLead !== null) {
              // check if new bid takes the lead
              const leadBid = auction.bids[currentLead];
              const minBidIncrementPct = params.minBidIncrementPercent / MAX_BID_INCREMENT_PERCENT;
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
              const ackPacket = {
                auctionId,
                account: newBid.account,
                oldBid: previousBid.bid,
                bid: newBid.bid,
                marketAccount: newBid.marketAccount,
                oldTimestamp: previousBid.timestamp,
                timestamp: newBid.timestamp,
              };

              if (previousBid.marketAccount !== marketAccount) {
                ackPacket.oldMarketAccount = previousBid.marketAccount;
              }

              api.emit('updateBid', ackPacket);
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

actions.cancelBid = async (payload) => {
  const {
    auctionId,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) return;

  if (api.assert(auctionId && typeof auctionId === 'string', 'invalid params')) {
    const auction = await api.db.findOne('auctions', { auctionId });

    if (api.assert(auction, 'auction does not exist or has been expired')) {
      const {
        priceSymbol,
        currentLead,
        expiryTimestamp,
        lastLeadUpdate,
      } = auction;

      // find if the account has any bid in this auction
      const bidIndex = auction.bids.findIndex(el => el.account === api.sender);
      const bid = auction.bids[bidIndex];

      const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
      const timestamp = blockDate.getTime();

      if (api.assert(bid, 'you do not have a bid in this auction')
        && api.assert(expiryTimestamp >= timestamp, 'auction has been expired')) {
        const params = await api.db.findOne('params', {});
        const timeRemaining = api.BigNumber(lastLeadUpdate)
          .plus(params.expiryTimeMillis)
          .minus(timestamp);
        const timeRemainingExpire = api.BigNumber(expiryTimestamp).minus(timestamp);

        // do not cancel bid if auction is about to settle
        if (api.assert(timeRemaining.gt(params.cancelLockTimeMillis)
          && timeRemainingExpire.gt(params.cancelLockTimeMillis), 'can not cancel bid when auction is about to settle')) {
          // remove this bid from the auction
          auction.bids.splice(bidIndex, 1);

          if (currentLead === bidIndex) {
            let largestBid = '0';
            let largestBidIndex = null;
            for (let i = 0; i < auction.bids.length; i += 1) {
              const { bid: quantity } = auction.bids[i];
              if (api.BigNumber(quantity).gt(largestBid)) {
                largestBid = quantity;
                largestBidIndex = i;
              }
            }

            auction.currentLead = largestBidIndex;
          } else if (currentLead > bidIndex) {
            // re-assign lead if a lower indexed bid is removed
            auction.currentLead -= 1;
          }

          await api.transferTokens(api.sender, priceSymbol, bid.bid, 'user');

          await api.db.update('auctions', auction);

          api.emit('cancelBid', {
            auctionId,
            ...bid,
          });
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

  const lastValidLead = timestamp - params.expiryTimeMillis;

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
    await settleAuction(auction);
  }
};

actions.setMarketParams = async (payload) => {
  const {
    symbol, officialMarket, agentCut, minFee, isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    return false;
  }

  // if no parameters supplied, we have nothing to do
  if (officialMarket === undefined && agentCut === undefined && minFee === undefined) {
    return false;
  }

  const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(nft, 'nft symbol does not exist')
    && api.assert((officialMarket === undefined || (officialMarket && typeof officialMarket === 'string' && api.isValidAccountName(officialMarket)))
      && (agentCut === undefined || (typeof agentCut === 'number' && agentCut >= 0 && agentCut <= 10000 && Number.isInteger(agentCut)))
      && (minFee === undefined || (typeof minFee === 'number' && minFee >= 0 && minFee <= 10000 && Number.isInteger(minFee))), 'invalid params')) {
    if (api.assert(nft.issuer === api.sender, 'must be the issuer')) {
      let shouldUpdate = false;
      let isFirstTimeSet = false;
      const update = {
        symbol,
      };

      let params = await api.db.findOne('marketParams', { symbol });
      if (!params) {
        isFirstTimeSet = true;
        params = {
          symbol,
        };
      }

      const finalOfficialMarket = (officialMarket !== undefined) ? officialMarket : null;
      if (officialMarket !== undefined
        && (params.officialMarket === undefined || finalOfficialMarket !== params.officialMarket)) {
        if (params.officialMarket !== undefined) {
          update.oldOfficialMarket = params.officialMarket;
        }
        params.officialMarket = finalOfficialMarket;
        update.officialMarket = finalOfficialMarket;
        shouldUpdate = true;
      }
      if (agentCut !== undefined
        && (params.agentCut === undefined || agentCut !== params.agentCut)) {
        if (params.agentCut !== undefined) {
          update.oldAgentCut = params.agentCut;
        }
        params.agentCut = agentCut;
        update.agentCut = agentCut;
        shouldUpdate = true;
      }
      if (minFee !== undefined && (params.minFee === undefined || minFee !== params.minFee)) {
        if (params.minFee !== undefined) {
          update.oldMinFee = params.minFee;
        }
        params.minFee = minFee;
        update.minFee = minFee;
        shouldUpdate = true;
      }

      if (shouldUpdate) {
        if (isFirstTimeSet) {
          await api.db.insert('marketParams', params);
        } else {
          await api.db.update('marketParams', params);
        }

        api.emit('setMarketParams', update);
        return true;
      }
    }
  }
  return false;
};
