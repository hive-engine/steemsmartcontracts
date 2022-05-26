const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const log = require('loglevel');
const { CONSTANTS } = require('../libs/Constants');

const { SmartContracts } = require('./SmartContracts');
const { Transaction } = require('../libs/Transaction');
const { setupContractPayload } = require('../libs/util/contractUtil');

const revertCommentsContractPayload = setupContractPayload('comments', './contracts/revert/comments_minify_20211027.js');

class Block {
  constructor(timestamp, refHiveBlockNumber, refHiveBlockId, prevRefHiveBlockId, transactions, previousBlockNumber, previousHash = '', previousDatabaseHash = '') {
    this.blockNumber = previousBlockNumber + 1;
    this.refHiveBlockNumber = refHiveBlockNumber;
    this.refHiveBlockId = refHiveBlockId;
    this.prevRefHiveBlockId = prevRefHiveBlockId;
    this.previousHash = previousHash;
    this.previousDatabaseHash = previousDatabaseHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.virtualTransactions = [];
    this.hash = this.calculateHash();
    this.databaseHash = '';
    this.merkleRoot = '';
    this.round = null;
    this.roundHash = '';
    this.witness = '';
    this.signingKey = '';
    this.roundSignature = '';
  }

  // calculate the hash of the block
  calculateHash() {
    return SHA256(
      this.previousHash
      + this.previousDatabaseHash
      + this.blockNumber.toString()
      + this.refHiveBlockNumber.toString()
      + this.refHiveBlockId
      + this.prevRefHiveBlockId
      + this.timestamp
      + this.merkleRoot
      + JSON.stringify(this.transactions) // eslint-disable-line
    )
      .toString(enchex);
  }

  // calculate the Merkle root of the block ((#TA + #TB) + (#TC + #TD) )
  calculateMerkleRoot(transactions) {
    if (transactions.length <= 0) return '';

    const tmpTransactions = transactions.slice(0, transactions.length);
    const newTransactions = [];
    const nbTransactions = tmpTransactions.length;

    for (let index = 0; index < nbTransactions; index += 2) {
      const left = tmpTransactions[index].hash;
      const right = index + 1 < nbTransactions ? tmpTransactions[index + 1].hash : left;

      const leftDbHash = tmpTransactions[index].databaseHash;
      const rightDbHash = index + 1 < nbTransactions
        ? tmpTransactions[index + 1].databaseHash
        : leftDbHash;

      newTransactions.push({
        hash: SHA256(left + right).toString(enchex),
        databaseHash: SHA256(leftDbHash + rightDbHash).toString(enchex),
      });
    }

    if (newTransactions.length === 1) {
      return {
        hash: newTransactions[0].hash,
        databaseHash: newTransactions[0].databaseHash,
      };
    }

    return this.calculateMerkleRoot(newTransactions);
  }

  async blockAdjustments(database) {
    if (this.refHiveBlockNumber === 43447729 || this.refHiveBlockNumber === 44870101) {
      // main node skipped this due to space issue
      this.transactions = [];
    }

    // To keep in sync with primary node history after hack
    if (this.refHiveBlockNumber === 50352631) {
      const tokenBalances = database.database.collection('tokens_balances');
      await tokenBalances.updateOne({ _id: 8416 }, { $set: { account: 'nightowl1', balance: '1.05000000' } });
      await tokenBalances.updateOne({ _id: 21725 }, { $set: { account: 'nightowl1', balance: '1010.00000000' } });
    } else if (this.refHiveBlockNumber === 50354478) {
      const tokenBalances = database.database.collection('tokens_balances');
      await tokenBalances.updateOne({ _id: 8416 }, { $set: { account: 'nightowl1', balance: '0.50000000' } });
    } else if (this.refHiveBlockNumber === 50354625) {
      const tokenBalances = database.database.collection('tokens_balances');
      await tokenBalances.updateOne({ _id: 21725 }, { $set: { account: 'nightowl1', balance: '500000.00000000' } });
    }

    // Comments contract causing issues and needs to be reverted. put at beginning
    if (this.refHiveBlockNumber === 58637536) {
      this.transactions.unshift(new Transaction(this.blockNumber, 'FIXTX_COMMENTS_REVERT', CONSTANTS.HIVE_ENGINE_ACCOUNT, 'contract', 'update', JSON.stringify(revertCommentsContractPayload)));
    }
  }

  /**
   * Try cleaning up blocks after every 100 blocks if node is a light node.
   * @param database
   * @returns {Promise<void>}
   */
  async cleanupLightNode(database) {
    if (this.blockNumber % 100 === 0) {
      await database.cleanupLightNode();
    }
  }

  // produce the block (deploy a smart contract or execute a smart contract)
  async produceBlock(database, jsVMTimeout, mainBlock) {
    await this.cleanupLightNode(database);
    await this.blockAdjustments(database);

    const nbTransactions = this.transactions.length;

    let currentDatabaseHash = this.previousDatabaseHash;

    let relIndex = 0;
    const allowCommentContract = this.refHiveBlockNumber > 54560500;
    for (let i = 0; i < nbTransactions; i += 1) {
      const transaction = this.transactions[i];
      log.info('Processing tx ', transaction);
      await this.processTransaction(database, jsVMTimeout, transaction, currentDatabaseHash); // eslint-disable-line

      currentDatabaseHash = transaction.databaseHash;

      if ((transaction.contract !== 'comments' || allowCommentContract) || transaction.logs === '{}') {
        if (mainBlock && currentDatabaseHash !== mainBlock.transactions[relIndex].databaseHash) {
          log.warn(mainBlock.transactions[relIndex]); // eslint-disable-line no-console
          log.warn(transaction); // eslint-disable-line no-console
          throw new Error('tx hash mismatch with api');
        }
        relIndex += 1;
      }
    }

    // remove comment, comment_options and votes if not relevant
    this.transactions = this.transactions.filter(value => (value.contract !== 'comments' || allowCommentContract) || value.logs === '{}');

    // handle virtual transactions
    const virtualTransactions = [];
    // reset in case block processing loops
    this.virtualTransactions = [];

    // use contracts_config contractTicks to trigger ticking contract actions.
    const contractsConfig = await database.getContractsConfig();

    for (let i = 0; i < contractsConfig.contractTicks.length; i += 1) {
      const contractTick = contractsConfig.contractTicks[i];
      if (this.refHiveBlockNumber >= contractTick.startRefBlock) {
        virtualTransactions.push(new Transaction(0, '', 'null', contractTick.contract, contractTick.action, ''));
      }
    }

    if (this.refHiveBlockNumber % 1200 === 0) {
      virtualTransactions.push(new Transaction(0, '', 'null', 'inflation', 'issueNewTokens', '{ "isSignedWithActiveKey": true }'));
    }

    relIndex = 0;
    const nbVirtualTransactions = virtualTransactions.length;
    for (let i = 0; i < nbVirtualTransactions; i += 1) {
      const transaction = virtualTransactions[i];
      transaction.refHiveBlockNumber = this.refHiveBlockNumber;
      transaction.transactionId = `${this.refHiveBlockNumber}-${i}`;
      await this.processTransaction(database, jsVMTimeout, transaction, currentDatabaseHash); // eslint-disable-line
      currentDatabaseHash = transaction.databaseHash;
      // if there are outputs in the virtual transaction we save the transaction into the block
      // the "unknown error" errors are removed as they are related to a non existing action
      if (transaction.logs !== '{}'
        && transaction.logs !== '{"errors":["unknown error"]}') {
        let tickingAction = false;
        for (let j = 0; j < contractsConfig.contractTicks.length; j += 1) {
          const contractTick = contractsConfig.contractTicks[j];
          if (transaction.contract === contractTick.contract
            && transaction.action === contractTick.action
          && transaction.logs === '{"errors":["contract doesn\'t exist"]}') {
            tickingAction = true;
          }
        }


        if (transaction.contract === 'inflation'
          && transaction.action === 'issueNewTokens'
          && transaction.logs === '{"errors":["contract doesn\'t exist"]}') {
          // don't save logs
        } else if (tickingAction) {
          // don't save logs
        } else {
          this.virtualTransactions.push(transaction);
          if (mainBlock && currentDatabaseHash
              !== mainBlock.virtualTransactions[relIndex].databaseHash) {
            log.warn(mainBlock.virtualTransactions[relIndex]); // eslint-disable-line no-console
            log.warn(transaction); // eslint-disable-line no-console
            throw new Error('tx hash mismatch with api');
          }
          relIndex += 1;
        }
      }
    }

    // add odd blocks, consensus appended double virtual transactions
    if (this.refHiveBlockNumber === 59376574) {
        this.virtualTransactions = this.virtualTransactions.concat(this.virtualTransactions);
    }

    if (this.transactions.length > 0 || this.virtualTransactions.length > 0) {
      // calculate the merkle root of the transactions' hashes and the transactions' database hashes
      const finalTransactions = this.transactions.concat(this.virtualTransactions);

      const merkleRoots = this.calculateMerkleRoot(finalTransactions);
      this.merkleRoot = merkleRoots.hash;
      this.databaseHash = merkleRoots.databaseHash;
      this.hash = this.calculateHash();
    } else if (currentDatabaseHash !== this.previousDatabaseHash) {
      await database.noteHashChange(this.refHiveBlockNumber);
    }
  }

  async processTransaction(database, jsVMTimeout, transaction, currentDatabaseHash) {
    const {
      sender,
      contract,
      action,
      payload,
    } = transaction;

    let results = null;
    let newCurrentDatabaseHash = currentDatabaseHash;

    // init the database hash for that transactions
    database.initDatabaseHash(newCurrentDatabaseHash);

    if (sender && contract && action) {
      if (contract === 'contract' && (action === 'deploy' || action === 'update') && payload) {
        const authorizedAccountContractDeployment = ['null', CONSTANTS.HIVE_ENGINE_ACCOUNT, CONSTANTS.HIVE_PEGGED_ACCOUNT];

        if (authorizedAccountContractDeployment.includes(sender)) {
          results = await SmartContracts.deploySmartContract( // eslint-disable-line
            database, transaction, this.blockNumber, this.timestamp,
            this.refHiveBlockId, this.prevRefHiveBlockId, jsVMTimeout,
          );
        } else {
          results = { logs: { errors: ['the contract deployment is currently unavailable'] } };
        }
      } else if (contract === 'contract' && action === 'registerTick' && payload) {
        const authorizedAccountTickRegister = [
          CONSTANTS.HIVE_ENGINE_ACCOUNT, CONSTANTS.HIVE_PEGGED_ACCOUNT];
        if (authorizedAccountTickRegister.includes(sender)) {
          results = await SmartContracts.registerTick(database, transaction);
        } else {
          results = { logs: { errors: ['registerTick unauthorized'] } };
        }
      } else {
        results = await SmartContracts.executeSmartContract(// eslint-disable-line
          database, transaction, this.blockNumber, this.timestamp,
          this.refHiveBlockId, this.prevRefHiveBlockId, jsVMTimeout,
        );
      }
    } else {
      results = { logs: { errors: ['the parameters sender, contract and action are required'] } };
    }
    if (results.logs && results.logs.errors && results.logs.errors.find(m => m.includes('MongoError'))) {
      throw new Error(`Mongo tx error, transaction: ${JSON.stringify(transaction)}, result: ${JSON.stringify(results)}`);
    }

    await database.flushCache();
    await database.flushContractCache();

    // get the database hash
    newCurrentDatabaseHash = database.getDatabaseHash();


    log.info('Tx results: ', results);
    transaction.addLogs(results.logs);
    transaction.executedCodeHash = results.executedCodeHash || ''; // eslint-disable-line
    transaction.databaseHash = newCurrentDatabaseHash; // eslint-disable-line

    transaction.calculateHash();
  }
}

module.exports.Block = Block;
