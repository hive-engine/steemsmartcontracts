/* eslint-disable no-await-in-loop */
/* global actions, api */

const WITHDRAW_PENALTY_FEE = 7;
const WITHDRAW_TOKEN_FEE = 2;
const WITHDRAW_AGENT_FEE = 1;
const CONTRACT_NAME = 'hodl';
const MILLISECONDS_IN_MONTH = 2592000000;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('lockUps');

  if (tableExists === false) {
    await api.db.createTable('lockUps', ['account', 'token']);
    await api.db.createTable('params');

    const params = {
      amountLockedUp: [],
    };

    await api.db.insert('params', params);
  } else {
    const params = await api.db.findOne('params', {});
    params.withdrawPenaltyFee = WITHDRAW_PENALTY_FEE;
    params.withdrawTokenFee = WITHDRAW_TOKEN_FEE;
    params.withdrawAgentFee = WITHDRAW_AGENT_FEE;
    await api.db.update('params', params);
  }
};
