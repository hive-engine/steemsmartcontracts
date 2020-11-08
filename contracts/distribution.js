/* eslint-disable no-await-in-loop */
/* eslint no-underscore-dangle: ["error", { "allow": ["_id"] }] */
/* global actions, api */

// limit recipients per distribution batch
const MAX_RECIPIENTS = 40;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('batches');
  if (tableExists === false) {
    await api.db.createTable('batches');
    await api.db.createTable('params');

    const params = {};
    params.distCreationFee = '500';
    params.distUpdateFee = '250';
    await api.db.insert('params', params);
  }
};

actions.updateParams = async (payload) => {
  if (api.sender !== api.owner) return;

  const {
    distCreationFee,
    distUpdateFee,
  } = payload;

  const params = await api.db.findOne('params', {});

  if (distCreationFee) {
    if (!api.assert(typeof distCreationFee === 'string' && !api.BigNumber(distCreationFee).isNaN() && api.BigNumber(distCreationFee).gte(0), 'invalid distCreationFee')) return;
    params.distCreationFee = distCreationFee;
  }
  if (distUpdateFee) {
    if (!api.assert(typeof distUpdateFee === 'string' && !api.BigNumber(distUpdateFee).isNaN() && api.BigNumber(distUpdateFee).gte(0), 'invalid distUpdateFee')) return;
    params.distUpdateFee = distUpdateFee;
  }

  await api.db.update('params', params);
};

async function processBatch(batch, symbol, isFlush = false) {
  let balance;
  let balanceInd;
  let payout;

  for (let i = 0; i < batch.tokenBalances.length; i += 1) {
    const curBalance = batch.tokenBalances[i];
    if (curBalance.symbol === symbol) {
      balanceInd = i;
      balance = curBalance.quantity;
      break;
    }
  }

  for (let i = 0; i < batch.tokenMinPayout.length; i += 1) {
    const minPayout = batch.tokenMinPayout[i];
    if (minPayout.symbol === symbol) {
      payout = minPayout.quantity;
      break;
    }
  }

  if (balance !== undefined && payout !== undefined
    && (api.BigNumber(balance).gt(api.BigNumber(payout)) || isFlush === true)) {
    // pay out token balance to recipients by configured share percentage
    for (let i = 0; i < batch.tokenRecipients.length; i += 1) {
      const recipient = batch.tokenRecipients[i];
      const recipientShare = api.BigNumber(balance).multipliedBy(recipient.pct / 100).toFixed(3);
      if (await api.transferTokens(recipient.account, symbol, recipientShare, recipient.type)) {
        // eslint-disable-next-line no-param-reassign, max-len
        batch.tokenBalances[balanceInd].quantity = api.BigNumber(batch.tokenBalances[balanceInd].quantity).minus(recipientShare);
        await api.db.update('batches', batch);
      }
    }
    return true;
  }
  return false;
}

/*
"tokenMinPayout": [
  {"symbol": "TKN", "quantity": 100},
  {"symbol": "TKNA", "quantity": 100.001},
]
*/
async function validateMinPayout(tokenMinPayout) {
  if (!api.assert(tokenMinPayout && Array.isArray(tokenMinPayout), 'tokenMinPayout must be an array')) return false;
  if (!api.assert(tokenMinPayout.length >= 1, 'specify at least one minimum payout configuration')) return false;

  const tokenMinPayoutSymbols = new Set();
  for (let i = 0; i < tokenMinPayout.length; i += 1) {
    const tokenMinPayoutConfig = tokenMinPayout[i];
    if (!api.assert(tokenMinPayoutConfig && tokenMinPayoutConfig.symbol
      && typeof (tokenMinPayoutConfig.symbol) === 'string', 'tokenMinPayout invalid')) return false;

    if (!api.assert(!tokenMinPayoutSymbols.has(tokenMinPayoutConfig.symbol), 'tokenMinPayout cannot have duplicate symbols')) return false;
    tokenMinPayoutSymbols.add(tokenMinPayoutConfig.symbol);

    if (!api.assert(tokenMinPayoutConfig.quantity
      && api.BigNumber(tokenMinPayoutConfig.quantity).dp() <= 3 && api.BigNumber(tokenMinPayoutConfig.quantity).gte(0), 'invalid quantity')) return false;
  }
  return true;
}

/*
"tokenRecipients": [
  {"account": "donchate", "type": "user", "pct": 50},
  {"account": "contractname", "type": "contract", "pct": 50}
]
*/
async function validateRecipients(tokenRecipients) {
  if (!api.assert(tokenRecipients && Array.isArray(tokenRecipients), 'tokenRecipients must be an array')) return false;
  if (!api.assert(tokenRecipients.length >= 1 && tokenRecipients.length <= MAX_RECIPIENTS, `1-${MAX_RECIPIENTS} tokenRecipients are supported`)) return false;

  const tokenRecipientsAccounts = new Set();
  let tokenRecipientsTotalShare = 0;
  for (let i = 0; i < tokenRecipients.length; i += 1) {
    const tokenRecipientsConfig = tokenRecipients[i];
    if (!api.assert(tokenRecipientsConfig && tokenRecipientsConfig.account
      && typeof (tokenRecipientsConfig.account) === 'string', 'tokenRecipients invalid')
      && !api.assert(tokenRecipientsConfig.account.length >= 3 && tokenRecipientsConfig.account.length <= 16, 'invalid account')) return false;

    if (!api.assert(!tokenRecipientsAccounts.has(tokenRecipientsConfig.account), 'tokenRecipients cannot have duplicate accounts')) return false;
    tokenRecipientsAccounts.add(tokenRecipientsConfig.account);

    if (!api.assert(Number.isInteger(tokenRecipientsConfig.pct)
      && tokenRecipientsConfig.pct >= 1 && tokenRecipientsConfig.pct <= 100,
    'tokenRecipients pct must be an integer from 1 to 100')) return false;
    tokenRecipientsTotalShare += tokenRecipientsConfig.pct;

    if (!api.assert(['user', 'contract'].includes(tokenRecipientsConfig.type), 'tokenRecipients type must be user or contract')) return false;
  }
  if (!api.assert(tokenRecipientsTotalShare === 100, 'tokenRecipients pct must total 100')) return false;
  return true;
}

function validateIncomingToken(batch, symbol) {
  for (let i = 0; i < batch.tokenMinPayout.length; i += 1) {
    if (batch.tokenMinPayout[i].symbol === symbol) return true;
  }
  return false;
}

actions.create = async (payload) => {
  const {
    tokenMinPayout, tokenRecipients, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { distCreationFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(distCreationFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(distCreationFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the creation fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    if (await validateMinPayout(tokenMinPayout) && await validateRecipients(tokenRecipients)) {
      const newDist = {
        tokenMinPayout,
        tokenRecipients,
        active: false,
        creator: api.sender,
      };
      const createdDist = await api.db.insert('batches', newDist);

      // burn the token creation fees
      if (api.sender !== api.owner && api.BigNumber(distCreationFee).gt(0)) {
        await api.executeSmartContract('tokens', 'transfer', {
          // eslint-disable-next-line no-template-curly-in-string
          to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: distCreationFee, isSignedWithActiveKey,
        });
      }
      api.emit('create', { id: createdDist._id });
    }
  }
};

// allow owner/creator to manually distribute a token
actions.flush = async (payload) => {
  const {
    id, symbol, isSignedWithActiveKey,
  } = payload;

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')
    && api.assert(api.sender === api.owner || api.sender === dist.creator, 'must be contract owner or creator')) {
    if (await processBatch(dist, symbol, true)) {
      api.emit('flush', { memo: `${symbol} payout distributed` });
    }
  }
};

actions.update = async (payload) => {
  const {
    id, tokenMinPayout, tokenRecipients, isSignedWithActiveKey,
  } = payload;

  // get contract params
  const params = await api.db.findOne('params', {});
  const { distUpdateFee } = params;

  // eslint-disable-next-line no-template-curly-in-string
  const utilityTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" });

  const authorizedCreation = api.BigNumber(distUpdateFee).lte(0) || api.sender === api.owner
    ? true
    : utilityTokenBalance && api.BigNumber(utilityTokenBalance.balance).gte(distUpdateFee);

  if (api.assert(authorizedCreation, 'you must have enough tokens to cover the update fee')
    && api.assert(isSignedWithActiveKey === true, 'you must use a transaction signed with your active key')) {
    const exDist = await api.db.findOne('batches', { _id: id });
    if (api.assert(exDist, 'distribution not found') && await validateMinPayout(tokenMinPayout)
      && await validateRecipients(tokenRecipients)) {
      exDist.tokenMinPayout = tokenMinPayout;
      exDist.tokenRecipients = tokenRecipients;
      await api.db.update('batches', exDist);

      // burn the token creation fees
      if (api.sender !== api.owner && api.BigNumber(distUpdateFee).gt(0)) {
        await api.executeSmartContract('tokens', 'transfer', {
          // eslint-disable-next-line no-template-curly-in-string
          to: 'null', symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'", quantity: distUpdateFee, isSignedWithActiveKey,
        });
      }
      api.emit('update', { id: exDist._id });
    }
  }
};

actions.setActive = async (payload) => {
  const {
    id,
    active,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')) {
    return;
  }
  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found')
    && api.assert(dist.creator === api.sender || api.owner === api.sender, 'you must be the creator of this distribution')) {
    dist.active = !!active;
    await api.db.update('batches', dist);
  }
};

actions.deposit = async (payload) => {
  const {
    id, symbol, quantity, isSignedWithActiveKey,
  } = payload;

  if (!api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && !api.assert(quantity && api.BigNumber(quantity).dp() <= 3 && api.BigNumber(quantity).gt(0), 'invalid quantity')) {
    return;
  }

  const dist = await api.db.findOne('batches', { _id: id });
  if (api.assert(dist, 'distribution id not found') && api.assert(dist.active, 'distribution must be active to deposit')
    && api.assert(validateIncomingToken(dist, symbol), `${symbol} is not accepted by this distribution`)) {
    // deposit requested tokens to contract
    const res = await api.executeSmartContract('tokens', 'transferToContract', { symbol, quantity, to: 'distribution' });
    if (res.errors === undefined
      && res.events && res.events.find(el => el.contract === 'tokens' && el.event === 'transferToContract' && el.data.from === api.sender && el.data.to === 'distribution' && el.data.quantity === quantity) !== undefined) {
      // update token balances
      if (dist.tokenBalances) {
        let hasBalance = false;
        for (let i = 0; i < dist.tokenBalances.length; i += 1) {
          if (dist.tokenBalances[i].symbol === symbol) {
            dist.tokenBalances[i].quantity += quantity;
            hasBalance = true;
            break;
          }
        }
        if (!hasBalance) {
          dist.tokenBalances.push({ symbol, quantity });
        }
      } else {
        dist.tokenBalances = [
          { symbol, quantity },
        ];
      }
      await api.db.update('batches', dist);
      // check if at minimum payout, and distribute
      const payNow = await processBatch(dist, symbol);
      if (payNow) {
        api.emit('deposit', { memo: `Deposit received. ${symbol} payout distributed` });
      } else {
        api.emit('deposit', { memo: `Deposit received. ${symbol} payout pending` });
      }
    }
  }
};
