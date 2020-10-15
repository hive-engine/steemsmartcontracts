const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'"
const CONTRACT_NAME = 'airdrops'

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pendingAirdrops');
  if (tableExists === false) {
    await api.db.createTable('pendingAirdrops', ['txId', 'symbol']);
    await api.db.createTable('params');

    const params = {};
    params.listGenerationFee = '500';
    params.feePerTransaction = '0.1';
    params.transactionsPerBlock = '50';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    listGenerationFee,
    feePerTransaction,
    transactionsPerBlock,
  } = payload;

  const params = await api.db.findOne('params', {});

  params.listGenerationFee = listGenerationFee;
  params.feePerTransaction = feePerTransaction;
  params.transactionsPerBlock = transactionsPerBlock;

  await api.db.update('params', params);
};

const parseAirdrop = async (list, precision) => {
  const params = await api.db.findOne('params', {});
  const airdrop = {};
  airdrop.list = [];
  airdrop.fee = '0';
  airdrop.amount = '0';
  airdrop.isValid = false;
  
  // convert csv to an array & then loop through it
  const listArray = list.split(',');
  listArray.forEach(value => {
    // get to & amount from raw value
    const { [0]:to, [1]:amount } = value.split(':');

    if (to && api.isValidAccountName(to)
      && amount && !api.BigNumber(amount).isNaN()
      && api.BigNumber(amount).gt(0) && api.BigNumber(amount).dp().lte(precision)) {
      airdrop.list.push({
        to,
        amount,
      });

      // add this amount to the total amount of tokens to airdrop
      airdrop.amount = api.BigNumber(airdrop.amount).plus(amount);
    }
  });
  
  // calculate total fee
  airdrop.fee = api.BigNumber(params.feePerTransaction).times(airdrop.list.length);

  // list validation, check if all values from listArray are valid & pushed into airdrop.list
  if (listArray.length > 0 && listArray.length === airdrop.list.length) {
    airdrop.isValid = true;
  }
  return airdrop;
}

actions.airdrop = async (payload) => {
  const {
    symbol, type, list, isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string'
      && list && typeof list === 'string'
      && type && typeof type === 'string', 'invalid params')
    && api.assert(type === 'liquid' || type === 'stake', 'invalid type')) {
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol });
    
    // get api.sender's utility and airdrop token balances
    const { balance: utilityTokenBalance } = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: UTILITY_TOKEN_SYMBOL });
    const { balance: nativeBalance } = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol });
    
    if (api.assert(token !== null, 'symbol does not exist')) {
      const airdrop = await parseAirdrop(list, token.precision);

      if (api.assert(airdrop.list.length > 0 && airdrop.isValid, 'invalid list')
        && api.assert(utilityTokenBalance
          && api.BigNumber(utilityTokenBalance).gte(airdrop.fee), 'you must have enough tokens to cover the airdrop fee')
        && api.assert(nativeBalance
          && api.BigNumber(nativeBalance).gte(airdrop.amount), 'you must have enough tokens to do the airdrop')) {
        // validations completed
        // deduct fee from sender's utility token balance
        await api.executeSmartContract('tokens', 'transfer', {
          to: 'null', symbol: UTILITY_TOKEN_SYMBOL, quantity: airdrop.fee, isSignedWithActiveKey,
        });

        // lock airdrop tokens by transfering them to contract
        await api.executeSmartContract('tokens', 'transferToContract', {
          to: CONTRACT_NAME, symbol, quantity: airdrop.amount,
        });
        
        await api.db.insert('pendingAirdrops', {
          txId: api.transactionId,
          symbol,
          list: airdrop.list,
        });
      }
    }
  }
};
