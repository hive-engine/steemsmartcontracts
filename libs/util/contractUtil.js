const fs = require('fs-extra');
const { Base64 } = require('js-base64');
const { CONSTANTS } = require('../Constants');

function setupContractPayload(name, file, additionalReplacements = null) {
  let contractCode = fs.readFileSync(file);
  contractCode = contractCode.toString();
  contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g, CONSTANTS.UTILITY_TOKEN_PRECISION);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g, CONSTANTS.UTILITY_TOKEN_SYMBOL);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.GOVERNANCE_TOKEN_PRECISION\}\$'/g, CONSTANTS.GOVERNANCE_TOKEN_PRECISION);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.GOVERNANCE_TOKEN_SYMBOL\}\$'/g, CONSTANTS.GOVERNANCE_TOKEN_SYMBOL);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.GOVERNANCE_TOKEN_MIN_VALUE\}\$'/g, CONSTANTS.GOVERNANCE_TOKEN_MIN_VALUE);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.HIVE_PEGGED_SYMBOL\}\$'/g, CONSTANTS.HIVE_PEGGED_SYMBOL);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.HIVE_ENGINE_ACCOUNT\}\$'/g, CONSTANTS.HIVE_ENGINE_ACCOUNT);
  contractCode = contractCode.replace(/'\$\{CONSTANTS.ACCOUNT_RECEIVING_FEES\}\$'/g, CONSTANTS.ACCOUNT_RECEIVING_FEES);
  if (additionalReplacements) {
    contractCode = additionalReplacements(contractCode);
  }

  const base64ContractCode = Base64.encode(contractCode);

  return {
    name,
    params: '',
    code: base64ContractCode,
  };
}

module.exports.setupContractPayload = setupContractPayload;
