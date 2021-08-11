/* eslint-disable no-await-in-loop */
/* global actions, api */

// eslint-disable-next-line no-template-curly-in-string
const UTILITY_TOKEN_SYMBOL = "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'";
// eslint-disable-next-line no-template-curly-in-string
const GOVERNANCE_TOKEN_SYMBOL = "'${CONSTANTS.GOVERNANCE_TOKEN_SYMBOL}$'";
// eslint-disable-next-line no-template-curly-in-string
const HIVE_ENGINE_ACCOUNT = "'${CONSTANTS.HIVE_ENGINE_ACCOUNT}$'";

actions.createSSC = async () => {

};

actions.issueNewTokens = async () => {
  if (api.sender !== 'null') return;
  // 100k tokens per year = 11.41552511 tokens per hour (an hour = 1200 blocks)
  const nbTokens = '11.41552511';
  // 1MM tokens per year = 2739.72602739 tokens per day
  const milTokens = '2739.72602739';

  // issue tokens to HIVE_ENGINE_ACCOUNT (100k/year)
  await api.executeSmartContract('tokens', 'issue',
    { symbol: UTILITY_TOKEN_SYMBOL, quantity: nbTokens, to: HIVE_ENGINE_ACCOUNT });

  // issue tokens to "witnesses" contract (100k/year)
  await api.executeSmartContract('tokens', 'issueToContract',
    { symbol: UTILITY_TOKEN_SYMBOL, quantity: nbTokens, to: 'witnesses' });

  // establish utility token DTF (up to 1MM/year)
  if (api.refHiveBlockNumber === 56428800) {
    await api.executeSmartContract('tokenfunds', 'createFund', {
      payToken: UTILITY_TOKEN_SYMBOL,
      voteToken: GOVERNANCE_TOKEN_SYMBOL,
      voteThreshold: '1',
      maxDays: '365',
      maxAmountPerDay: milTokens,
      proposalFee: {
        method: 'burn',
        symbol: UTILITY_TOKEN_SYMBOL,
        amount: '25',
      },
    });
    await api.executeSmartContract('tokenfunds', 'setDtfActive', {
      fundId: `${UTILITY_TOKEN_SYMBOL}:${GOVERNANCE_TOKEN_SYMBOL}`,
      active: true,
    });
  }
};
