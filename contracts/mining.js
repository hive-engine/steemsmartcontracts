/* eslint-disable no-await-in-loop */
/* global actions, api */

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('miningPower');
  if (tableExists === false) {
    await api.db.createTable('miningPower', ['id', 'power']);
    await api.db.createTable('pools', ['id']);
    // Given symbol, output which pools are using it.
    await api.db.createTable('tokenPools', ['symbol']);
    await api.db.createTable('params');

    const params = {};
    params.poolCreationFee = '1000';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const { poolCreationFee } = payload;

  const params = await api.db.findOne('params', {});

  params.poolCreationFee = poolCreationFee;
  await api.db.update('params', params);
};

actions.updatePool = async (payload) => {
  const { id } = payload;

  if (api.assert(id && typeof id === 'string', 'invalid params')) {
    const pool = await api.db.findOne('pools', { id });

    if (pool) {
      if (api.assert(pool.owner === api.sender, 'must be the owner')) {
        // TODO: update pool
      }
    }
  }
};

async function validateTokenMiners(tokenMiners) {
  if (!api.assert(tokenMiners && typeof tokenMiners === 'object')) return false;
  const tokens = Object.keys(tokenMiners);
  if (!api.assert(tokens.length >= 1 && tokens.length <= 2, 'only 1 or 2 tokenMiners allowed')) return false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const tokenObject = await api.db.findOneInTable('tokens', 'tokens', { symbol: token });
    if (!api.assert(tokenObject && tokenObject.stakingEnabled, 'tokenMiners must have staking enabled')) return false;
    if (!api.assert(Number.isInteger(tokenMiners[token]) && tokenMiners[token] >= 1 && tokenMiners[token] <= 100, 'tokenMiner multiplier must be an integer from 1 to 100')) return false;
  }
  return true;
}

function generatePoolId(pool) {
  const tokenMinerString = Object.keys(pool.tokenMiners).join('_');
  return `${pool.minedToken}-${tokenMinerString}`;
}

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

function computeMiningPower(miningPower, tokenMiners) {
  let power = api.BigNumber(0);
  Object.keys(tokenMiners).forEach((token) => {
    if (miningPower.balances[token]) {
      power = power.plus(api.BigNumber(miningPower.balances[token])
        .multipliedBy(tokenMiners[token]));
    }
  });
  return power;
}

async function updateMiningPower(pool, token, account, stakedQuantity, delegatedQuantity) {
  let miningPower = await api.db.findOne('miningPower', { id: pool.id, account });
  let stake = api.BigNumber(stakedQuantity);
  let oldMiningPower = api.BigNumber(0);
  stake = stake.plus(delegatedQuantity);
  if (!miningPower) {
    const balances = {};
    balances[token] = stake;
    miningPower = {
      id: pool.id,
      account,
      balances,
      power: { $numberDecimal: '0' },
    };
    miningPower = await api.db.insert('miningPower', miningPower);
  } else {
    if (!miningPower.balances[token]) {
      miningPower.balances[token] = '0';
    }
    miningPower.balances[token] = stake.plus(miningPower.balances[token]);
    oldMiningPower = miningPower.power.$numberDecimal;
  }
  const newMiningPower = computeMiningPower(miningPower, pool.tokenMiners);
  miningPower.power = { $numberDecimal: newMiningPower };
  await api.db.update('miningPower', miningPower);
  return newMiningPower.minus(oldMiningPower);
}

async function initMiningPower(pool, token) {
  let totalAdjusted = api.BigNumber(0);
  await findAndProcessAll('tokens', 'balances', { symbol: token }, async (balance) => {
    const adjusted = await updateMiningPower(
      pool, token, balance.account, balance.stake, balance.delegationsIn,
    );
    totalAdjusted = totalAdjusted.plus(adjusted);
  });
  return totalAdjusted;
}

actions.createPool = async (payload) => {
  const {
    lotteryWinners, lotteryIntervalHours, lotteryAmount, minedToken, tokenMiners,
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { poolCreationFee } = params;

  // get api.sender's UTILITY_TOKEN_SYMBOL balance
  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(poolCreationFee).lte(0)
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(poolCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
      && api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
      && api.assert(minedToken && typeof minedToken === 'string'
        && lotteryAmount && typeof lotteryAmount === 'string' && !api.BigNumber(lotteryAmount).isNaN(), 'invalid params')) {
    if (api.assert(minedToken.length > 0 && minedToken.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
      && api.assert(Number.isInteger(lotteryWinners) && lotteryWinners >= 1 && lotteryWinners <= 20, 'invalid lotteryWinners: integer between 1 and 20 only')
      && api.assert(Number.isInteger(lotteryIntervalHours) && lotteryIntervalHours >= 1 && lotteryIntervalHours <= 720, 'invalid lotteryIntervalHours: integer between 1 and 720 only')
    ) {
      const minedTokenObject = await api.db.findOneInTable('tokens', 'tokens', { symbol: minedToken });

      if (api.assert(minedTokenObject, 'minedToken does not exist')
        && api.assert(minedTokenObject.issuer === api.sender, 'must be issuer of minedToken')
        && api.assert(api.BigNumber(lotteryAmount).dp() <= minedTokenObject.precision, 'minedToken precision mismatch for lotteryAmount')
        && await validateTokenMiners(tokenMiners)) {
        const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
        const newPool = {
          owner: api.sender,
          minedToken,
          lotteryWinners,
          lotteryIntervalHours,
          lotteryAmount,
          tokenMiners,
          active: true,
          nextLotteryTimestamp: api.BigNumber(blockDate.getTime())
            .plus(lotteryIntervalHours * 3600 * 1000).toNumber(),
          totalPower: '0',
        };
        newPool.id = generatePoolId(newPool);

        const tokenMinerSymbols = Object.keys(tokenMiners);
        for (let i = 0; i < tokenMinerSymbols.length; i += 1) {
          const token = tokenMinerSymbols[i];
          await api.db.insert('tokenPools', { symbol: token, id: newPool.id });
          const adjustedPower = await initMiningPower(newPool, token);
          newPool.totalPower = api.BigNumber(newPool.totalPower)
            .plus(adjustedPower);
        }
        await api.db.insert('pools', newPool);

        // burn the token creation fees
        if (api.BigNumber(poolCreationFee).gt(0)) {
          await api.executeSmartContract('tokens', 'transfer', {
            // eslint-disable-next-line no-template-curly-in-string
            to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: poolCreationFee, isSignedWithActiveKey,
          });
        }
      }
    }
  }
};

actions.checkPendingLotteries = async () => {
  if (api.assert(api.sender === 'null', 'not authorized')) {
    const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
    const timestamp = blockDate.getTime();

    await findAndProcessAll('mining', 'pools',
      {
        nextLotteryTimestamp: {
          $lte: timestamp,
        },
      },
      async (pool) => {
        const winningNumbers = [];
        const minedToken = await api.db.findOneInTable('tokens', 'tokens',
          { symbol: pool.minedToken });
        const winningAmount = api.BigNumber(pool.lotteryAmount).dividedBy(pool.lotteryWinners)
          .toFixed(minedToken.precision);
        for (let i = 0; i < pool.lotteryWinners; i += 1) {
          winningNumbers[i] = api.BigNumber(pool.totalPower).multipliedBy(api.random());
          api.emit('miningLotteryDebug', winningNumbers[i]);
        }
        // iterate power desc
        let offset = 0;
        let miningPowers;
        let cumulativePower = api.BigNumber(0);
        let nextCumulativePower = api.BigNumber(0);
        let computedWinners = 0;
        const winners = [];
        while (computedWinners < pool.lotteryWinners) {
          miningPowers = await api.db.find('miningPower', { id: pool.id, power: { $gt: { $numberDecimal: '0' } } }, 1000, offset, [{ index: 'power', descending: true }]);
          for (let i = 0; i < miningPowers.length; i += 1) {
            const miningPower = miningPowers[i];
            api.emit('miningLotteryDebug', miningPower);
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
                await api.executeSmartContract('tokens', 'issue',
                  { to: miningPower.account, symbol: minedToken.symbol, quantity: winningAmount });
              }
            }
            cumulativePower = nextCumulativePower;
          }
          if (computedWinners === pool.lotteryWinners || miningPowers.length < 1000) {
            break;
          }
          offset += 1000;
        }
        api.emit('miningLottery', { poolId: pool.id, winners });
      });
  }
};

actions.handleStakeChange = async (payload) => {
  const {
    account, symbol, quantity, delegated, callingContractInfo,
  } = payload;
  if (api.assert(callingContractInfo.name === 'tokens'
      && api.sender === api.owner, 'must be called from tokens contract')) {
    await findAndProcessAll('mining', 'tokenPools', { symbol }, async (tokenPool) => {
      const pool = await api.db.findOne('pools', { id: tokenPool.id });
      let adjusted;
      if (delegated) {
        adjusted = await updateMiningPower(pool, symbol, account, 0, quantity);
      } else {
        adjusted = await updateMiningPower(pool, symbol, account, quantity, 0);
      }
      pool.totalPower = adjusted.plus(pool.totalPower)
      await api.db.update('pools', pool);
    });
  }
};
