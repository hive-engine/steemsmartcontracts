/* eslint-disable no-await-in-loop */
/* eslint-disable valid-typeof */
/* eslint-disable max-len */
/* global actions, api */

const CONTRACT_NAME = 'marketmaker';

// this placeholder represents BEE tokens on Hive Engine, ENG on Steem Engine, and SSC on the testnet
// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('users');
  if (tableExists === false) {
    await api.db.createTable('users', ['account']);
    await api.db.createTable('markets', ['account', 'symbol']);
    await api.db.createTable('params');

    const params = {};
    params.premiumBaseStake = '1000';
    params.premiumStakePerMarket = '200';
    params.freeDurationBlocks = '403200';  // 14 days
    params.freeCooldownBlocks = '403200';  // 14 days
    params.authorizedTicker = 'enginemaker';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    premiumBaseStake,
    premiumStakePerMarket,
    freeDurationBlocks,
    freeCooldownBlocks,
    authorizedTicker,
  } = payload;

  const params = await api.db.findOne('params', {});

  if (premiumBaseStake && typeof premiumBaseStake === 'string' && !api.BigNumber(premiumBaseStake).isNaN() && api.BigNumber(premiumBaseStake).gte(0)) {
    params.premiumBaseStake = premiumBaseStake;
  }
  if (premiumStakePerMarket && typeof premiumStakePerMarket === 'string' && !api.BigNumber(premiumStakePerMarket).isNaN() && api.BigNumber(premiumStakePerMarket).gte(0)) {
    params.premiumStakePerMarket = premiumStakePerMarket;
  }
  if (freeDurationBlocks && typeof freeDurationBlocks === 'string' && !api.BigNumber(freeDurationBlocks).isNaN() && api.BigNumber(freeDurationBlocks).gte(0)) {
    params.freeDurationBlocks = freeDurationBlocks;
  }
  if (freeCooldownBlocks && typeof freeCooldownBlocks === 'string' && !api.BigNumber(freeCooldownBlocks).isNaN() && api.BigNumber(freeCooldownBlocks).gte(0)) {
    params.freeCooldownBlocks = freeCooldownBlocks;
  }
  if (authorizedTicker && typeof authorizedTicker === 'string') {
    params.authorizedTicker = authorizedTicker;
  }

  await api.db.update('params', params);
};

// check that token transfers succeeded
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

actions.tickUser = async (payload) => {
  const {
    account,
    market,
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(account === undefined || (account && api.sender === params.authorizedTicker), 'not authorized to specify account parameter')
    && api.assert(account === undefined || api.isValidAccountName(account), 'invalid account name')
    && api.assert(market === undefined || (market && typeof market === 'string'), 'invalid params')) {
    const finalAccount = account ? account : api.sender;

    // check if user is registered
    const user = await api.db.findOne('users', { account: finalAccount });
    if (api.assert(user !== null, 'user not registered') {
      const lastTickBlock = user.lastTickBlock;
      const currentTickBlock = api.blockNumber;
    }
  }
};

actions.register = async (payload) => {
  const {
    isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) {
    // check if this user is already registered
    const user = await api.db.findOne('users', { account: api.sender });
    if (api.assert(user === null, 'user already registered')) {
      const blockDate = new Date(`${api.hiveBlockTimestamp}.000Z`);
      const creationTimestamp = blockDate.getTime();

      const newUser = {
        account: api.sender,
        isPremium: false,
        isOnCooldown: false,
        isEnabled: true,
        markets: 0,
        timeLimitBlocks: params.freeDurationBlocks,
        lastTickBlock: 0,
        creationTimestamp,
      };

      await api.db.insert('users', newUser);

      api.emit('register', {
        account: api.sender
      });
      return true;
    }
  }
  return false;
};
