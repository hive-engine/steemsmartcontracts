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

  // issue tokens to HIVE_ENGINE_ACCOUNT (100k/year)
  // 100k tokens per year = 11.41552511 tokens per hour (an hour = 1200 blocks)
  await api.executeSmartContract('tokens', 'issue',
    { symbol: UTILITY_TOKEN_SYMBOL, quantity: '11.41552511', to: HIVE_ENGINE_ACCOUNT });

  // issue tokens to "witnesses" contract (200k/year)
  await api.executeSmartContract('tokens', 'issueToContract',
    { symbol: UTILITY_TOKEN_SYMBOL, quantity: '22.83105022', to: 'witnesses' });

  // establish utility token DTFs
  if (api.refHiveBlockNumber === 56977200) {
    // BEE:WORKERBEE at up to 200k/year
    await api.executeSmartContract('tokenfunds', 'createFund', {
      payToken: UTILITY_TOKEN_SYMBOL,
      voteToken: GOVERNANCE_TOKEN_SYMBOL,
      voteThreshold: '6667',
      maxDays: '365',
      maxAmountPerDay: '547.94522054',
      proposalFee: {
        method: 'burn',
        symbol: UTILITY_TOKEN_SYMBOL,
        amount: '50',
      },
    });
    await api.executeSmartContract('tokenfunds', 'setDtfActive', {
      fundId: `${UTILITY_TOKEN_SYMBOL}:${GOVERNANCE_TOKEN_SYMBOL}`,
      active: true,
    });
    // BEE:BEE at up to 800k/year
    await api.executeSmartContract('tokenfunds', 'createFund', {
      payToken: UTILITY_TOKEN_SYMBOL,
      voteToken: UTILITY_TOKEN_SYMBOL,
      voteThreshold: '20000',
      maxDays: '365',
      maxAmountPerDay: '2191.78082191',
      proposalFee: {
        method: 'burn',
        symbol: UTILITY_TOKEN_SYMBOL,
        amount: '50',
      },
    });
    await api.executeSmartContract('tokenfunds', 'setDtfActive', {
      fundId: `${UTILITY_TOKEN_SYMBOL}:${UTILITY_TOKEN_SYMBOL}`,
      active: true,
    });
  }
};
