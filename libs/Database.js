/* eslint-disable max-len */
/* eslint-disable no-await-in-loop */
const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');
const log = require('loglevel');
const validator = require('validator');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');
const { CONSTANTS } = require('../libs/Constants');

// Change this to turn on hash logging.
const enableHashLogging = false;

function validateIndexName(indexName) {
  if (typeof indexName !== 'string') {
    return false;
  }
  const indexNameParts = indexName.split('.');
  return indexNameParts.every(p => p.length > 0 && validator.isAlphanumeric(p));
}

function validateIndexSpec(spec) {
  if (typeof spec === 'string') return validateIndexName(spec);
  if (typeof spec === 'object') {
    return spec.name && validator.isAlphanumeric(spec.name) && typeof spec.index === 'object'
          && Object.keys(spec.index).every(indexName => validateIndexName(indexName))
          && Object.values(spec.index).every(asc => asc === 1 || asc === -1);
  }
  return false;
}

async function indexInformation(tableData) {
  try {
    return await tableData.indexInformation();
  } catch (err) {
    // Fails if collection was created in the same
    // Mongo transaction. Proceed without indexes.
    return {};
  }
}

function objectCacheKey(contract, table, object) {
  if (contract === 'mining' && table === 'miningPower') {
    return `${contract}_${table}_${object.id}_${object.account}`;
  }
  return null;
}

function adjustQueryForPrimaryKey(query, customPrimaryKey) {
  const primaryKeyQuery = {};
  let usePrimaryKey = true;
  customPrimaryKey.forEach((k) => {
    if (k in query) {
      primaryKeyQuery[k] = query[k];
    } else {
      usePrimaryKey = false;
    }
  });
  if (usePrimaryKey) {
    query._id = primaryKeyQuery; // eslint-disable-line no-underscore-dangle, no-param-reassign
  }
}


class Database {
  constructor() {
    this.database = null;
    this.chain = null;
    this.databaseHash = '';
    this.client = null;
    this.session = null;
    this.contractCache = {};
    this.objectCache = {};
  }

  startSession() {
    this.session = this.client.startSession();
    this.contractCache = {};
    this.objectCache = {};
    return this.session;
  }

  async endSession() {
    if (this.session) {
      await this.session.endSession();
      this.session = null;
    }
  }

  async initSequence(name, startID = 1) {
    const sequences = this.database.collection('sequences');

    await sequences.insertOne({ _id: name, seq: startID }, { session: this.session });
  }

  async getNextSequence(name) {
    const sequences = this.database.collection('sequences');

    const sequence = await sequences.findOneAndUpdate(
      { _id: name }, { $inc: { seq: 1 } }, { new: true, session: this.session },
    );

    return sequence.value.seq;
  }

  async getLastSequence(name) {
    const sequences = this.database.collection('sequences');

    const sequence = await sequences.findOne({ _id: name }, { session: this.session });

    return sequence.seq;
  }

  async getContractCollection(contract, name) {
    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[name] !== undefined) {
      return this.database.collection(name);
    }
    return null;
  }

  getCollection(name) {
    return new Promise((resolve) => {
      this.database.collection(name, { strict: true }, (err, collection) => {
        // collection does not exist
        if (err) {
          resolve(null);
        } else {
          resolve(collection);
        }
      });
    });
  }

  async init(databaseURL, databaseName) {
    // init the database
    this.client = await MongoClient.connect(databaseURL, { useNewUrlParser: true, useUnifiedTopology: true });
    this.database = await this.client.db(databaseName);
    // await database.dropDatabase();
    // return
    // get the chain collection and init the chain if not done yet

    const coll = await this.getCollection('chain');

    if (coll === null) {
      await this.initSequence('chain', 0);
      this.chain = await this.database.createCollection('chain', { session: this.session });

      await this.database.createCollection('transactions', { session: this.session });
      await this.database.createCollection('contracts', { session: this.session });
    } else {
      this.chain = coll;
    }

    const contractsConfigColl = await this.getCollection('contracts_config');
    if (contractsConfigColl === null) {
      const newContractsConfigColl = await this.database.createCollection('contracts_config', { session: this.session });
      // WARNING: Do not add any more entries to this initial configuration.
      // Future contracts must use the contract action 'registerTick'.
      await newContractsConfigColl.insertOne({
        contractTicks: CONSTANTS.INITIAL_CONTRACT_TICKS,
      }, { session: this.session });
    }
  }

  close() {
    this.client.close();
  }

  async insertGenesisBlock(genesisBlock) {
    // eslint-disable-next-line
    genesisBlock._id = await this.getNextSequence('chain');

    await this.chain.insertOne(genesisBlock, { session: this.session });
  }

  async addTransactions(block) {
    const transactionsTable = this.database.collection('transactions');
    const { transactions } = block;
    const nbTransactions = transactions.length;

    for (let index = 0; index < nbTransactions; index += 1) {
      const transaction = transactions[index];
      const transactionToSave = {
        _id: transaction.transactionId,
        blockNumber: block.blockNumber,
        index,
      };

      await transactionsTable.insertOne(transactionToSave, { session: this.session }); // eslint-disable-line no-await-in-loop
    }
  }

  async updateTableHash(contract, table) {
    const contractInDb = await this.findContract({ name: contract });

    if (contractInDb && contractInDb.tables[table] !== undefined) {
      const tableHash = contractInDb.tables[table].hash;

      contractInDb.tables[table].hash = SHA256(tableHash).toString(enchex);

      const oldDatabaseHash = this.databaseHash;
      this.databaseHash = SHA256(this.databaseHash + contractInDb.tables[table].hash)
        .toString(enchex);
      if (enableHashLogging) {
        log.info(`updated hash of ${table} to ${contractInDb.tables[table].hash}`); // eslint-disable-line no-console
        log.info(`updated db hash from ${oldDatabaseHash} to ${this.databaseHash}`); // eslint-disable-line no-console
      }
    }
  }

  initDatabaseHash(previousDatabaseHash) {
    this.databaseHash = previousDatabaseHash;
  }

  getDatabaseHash() {
    return this.databaseHash;
  }

  async getTransactionInfo(txid) {
    const transactionsTable = this.database.collection('transactions');

    const transaction = await transactionsTable.findOne({ _id: txid }, { session: this.session });

    let result = null;

    if (transaction) {
      const { index, blockNumber } = transaction;
      const block = await this.getBlockInfo(blockNumber);

      if (block) {
        result = Object.assign({}, { blockNumber }, block.transactions[index]);
      }
    }

    return result;
  }

  async addBlock(block) {
    const finalBlock = block;
    finalBlock._id = await this.getNextSequence('chain'); // eslint-disable-line no-underscore-dangle
    await this.chain.insertOne(finalBlock, { session: this.session });
    await this.addTransactions(finalBlock);
  }

  async noteHashChange(refHiveBlockNumber) {
    const lastBlock = await this.getLatestBlockInfo();
    if (!lastBlock.otherHashChangeRefHiveBlocks) {
      lastBlock.otherHashChangeRefHiveBlocks = [];
    }
    lastBlock.otherHashChangeRefHiveBlocks.push(refHiveBlockNumber);
    await this.chain.updateOne({ _id: lastBlock._id }, { $set: { otherHashChangeRefHiveBlocks: lastBlock.otherHashChangeRefHiveBlocks } }, { session: this.session }); // eslint-disable-line no-underscore-dangle
  }

  async getLatestBlockInfo() {
    try {
      const _idNewBlock = await this.getLastSequence('chain'); // eslint-disable-line no-underscore-dangle

      const latestBlock = await this.chain.findOne({ _id: _idNewBlock - 1 }, { session: this.session });

      return latestBlock;
    } catch (error) {
      // eslint-disable-next-line no-console
      log.error(error);
      return null;
    }
  }

  async getLatestBlockMetadata() {
    try {
      const _idNewBlock = await this.getLastSequence('chain'); // eslint-disable-line no-underscore-dangle

      const latestBlock = await this.chain.findOne({ _id: _idNewBlock - 1 }, { session: this.session });

      if (latestBlock) {
        latestBlock.transactions = [];
        latestBlock.virtualTransactions = [];
      }
      return latestBlock;
    } catch (error) {
      // eslint-disable-next-line no-console
      log.error(error);
      return null;
    }
  }

  async getBlockInfo(blockNumber) {
    try {
      const block = typeof blockNumber === 'number' && Number.isInteger(blockNumber)
        ? await this.chain.findOne({ _id: blockNumber }, { session: this.session })
        : null;

      return block;
    } catch (error) {
      // eslint-disable-next-line no-console
      log.error(error);
      return null;
    }
  }

  /**
   * Mark a block as verified by a witness
   * @param {Integer} blockNumber block umber to mark verified
   * @param {String} witness name of the witness that verified the block
   */
  async verifyBlock(payload) {
    try {
      const {
        blockNumber,
        witness,
        roundSignature,
        signingKey,
        round,
        roundHash,
      } = payload;
      const block = await this.chain.findOne({ _id: blockNumber }, { session: this.session });

      if (block) {
        block.witness = witness;
        block.round = round;
        block.roundHash = roundHash;
        block.signingKey = signingKey;
        block.roundSignature = roundSignature;

        await this.chain.updateOne(
          { _id: block._id }, // eslint-disable-line no-underscore-dangle
          { $set: block }, { session: this.session },
        );
      } else {
        // eslint-disable-next-line no-console
        log.error('verifyBlock', blockNumber, 'does not exist');
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      log.error(error);
    }
  }

  /**
   * Get the information of a contract (owner, source code, etc...)
   * @param {String} contract name of the contract
   * @returns {Object} returns the contract info if it exists, null otherwise
   */
  async findContract(payload) {
    const { name } = payload;
    if (this.session && this.contractCache[name]) {
      return this.contractCache[name];
    }
    try {
      if (name && typeof name === 'string') {
        const contracts = this.database.collection('contracts');

        const contractInDb = await contracts.findOne({ _id: name }, { session: this.session });

        if (contractInDb) {
          this.contractCache[name] = contractInDb;
          return contractInDb;
        }
      }

      return null;
    } catch (error) {
      // eslint-disable-next-line no-console
      log.error(error);
      return null;
    }
  }

  /**
   * add a smart contract to the database
   * @param {String} _id _id of the contract
   * @param {String} owner owner of the contract
   * @param {String} code code of the contract
   * @param {String} tables tables linked to the contract
   */
  async addContract(payload) {
    const {
      _id,
      owner,
      code,
      tables,
    } = payload;

    if (_id && typeof _id === 'string'
      && owner && typeof owner === 'string'
      && code && typeof code === 'string'
      && tables && typeof tables === 'object') {
      const contracts = this.database.collection('contracts');
      await contracts.insertOne(payload, { session: this.session });
    }
  }

  /**
   * update a smart contract in the database
   * @param {String} _id _id of the contract
   * @param {String} owner owner of the contract
   * @param {String} code code of the contract
   * @param {String} tables tables linked to the contract
   */

  async updateContract(payload) {
    const {
      _id,
      owner,
      code,
      tables,
    } = payload;

    if (_id && typeof _id === 'string'
      && owner && typeof owner === 'string'
      && code && typeof code === 'string'
      && tables && typeof tables === 'object') {
      const contracts = this.database.collection('contracts');

      await this.flushContractCache();
      const contract = await contracts.findOne({ _id, owner }, { session: this.session });
      if (contract !== null) {
        await contracts.updateOne({ _id }, { $set: payload }, { session: this.session });
      }
    }
  }

  /**
   * Get contracts configuration data.
   */
  async getContractsConfig() {
    const contractsConfig = await this.getCollection('contracts_config');
    return contractsConfig.findOne({}, { session: this.session });
  }

  /**
   * Update contracts configuration data.
   * @param {Object} config data.
   */
  async updateContractsConfig(config) {
    const contractsConfig = await this.getCollection('contracts_config');
    await contractsConfig.updateOne({}, { $set: config }, { session: this.session });
  }

  /**
   * Add a table to the database
   * @param {String} contractName name of the contract
   * @param {String} tableName name of the table
   * @param {Array} indexes array of string containing the name of the indexes to create
   * @param {Object} params extra table creation parameters:
   *   - primaryKey { Array<String> } array of string keys comprising the primary key
   */
  async createTable(payload) {
    const {
      contractName, tableName, indexes, params,
    } = payload;
    let result = false;

    // check that the params are correct
    // each element of the indexes array have to be a string if defined
    if (validator.isAlphanumeric(tableName)
      && Array.isArray(indexes)
      && (indexes.length === 0
        || (indexes.length > 0 && indexes.every(el => validateIndexSpec(el))))
      && (!params.primaryKey
        || (Array.isArray(params.primaryKey) && params.primaryKey.length > 0
            && params.primaryKey.every(el => validator.isAlphanumeric(el))))) {
      const finalTableName = `${contractName}_${tableName}`;
      // get the table from the database
      let table = await this.getContractCollection(contractName, finalTableName);
      if (table === null) {
        // if it doesn't exist, create it (with the binary indexes)
        await this.initSequence(finalTableName);
        await this.database.createCollection(finalTableName, { session: this.session });
        table = this.database.collection(finalTableName);

        if (indexes.length > 0) {
          const nbIndexes = indexes.length;

          for (let i = 0; i < nbIndexes; i += 1) {
            const index = indexes[i];
            const indexOptions = { session: this.session };
            let finalIndex = {};
            if (typeof index === 'object') {
              indexOptions.name = index.name;
              finalIndex = index.index;
            } else {
              finalIndex[index] = 1;
            }
            await table.createIndex(finalIndex, indexOptions);
          }
        }

        result = true;
      }
    } else {
      log.warn(`Table invalid, was not created, payload: ${JSON.stringify(payload)}`); // eslint-disable-line no-console
    }

    return result;
  }

  /**
   * Add indexes to an existing table
   * @param {String} contractName name of the contract
   * @param {String} tableName name of the table
   * @param {Array} indexes array of string containing the name of the indexes to create
   */
  async addIndexes(payload) {
    const { contractName, tableName, indexes } = payload;
    let result = 0;

    // check that the params are correct
    // each element of the indexes array have to be a string if defined
    if (validator.isAlphanumeric(tableName)
      && Array.isArray(indexes)
      && (indexes.length === 0
        || (indexes.length > 0 && indexes.every(el => validateIndexSpec(el))))) {
      const finalTableName = `${contractName}_${tableName}`;
      // get the table from the database
      const table = await this.getContractCollection(contractName, finalTableName);
      if (table !== null) {
        if (indexes.length > 0) {
          const nbIndexes = indexes.length;

          const tableIndexes = await indexInformation(table);

          for (let i = 0; i < nbIndexes; i += 1) {
            const index = indexes[i];
            // Do not do this within session, cannot add indexes in same tx.
            const indexOptions = {};
            let finalIndex = {};
            let createIndex = true;
            if (typeof index === 'object') {
              if (tableIndexes[index.name] !== undefined) {
                log.info(`Index with name ${index.name} already exists for ${finalTableName}`); // eslint-disable-line no-console
                createIndex = false;
              } else {
                indexOptions.name = index.name;
                finalIndex = index.index;
              }
            } else if (tableIndexes[`${index}_1`] !== undefined) {
              log.info(`Index ${index} already exists for ${finalTableName}`); // eslint-disable-line no-console
              createIndex = false;
            } else {
              finalIndex[index] = 1;
            }
            if (createIndex) {
              await table.createIndex(finalIndex, indexOptions);
              result += 1;
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * retrieve records from the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @param {Integer} limit limit the number of records to retrieve
   * @param {Integer} offset offset applied to the records set
   * @param {Array<Object>} indexes array of index definitions { index: string, descending: boolean }
   * @returns {Array<Object>} returns an array of objects if records found, an empty array otherwise
   */
  async find(payload) {
    try {
      const {
        contract,
        table,
        query,
        limit,
        offset,
        indexes,
      } = payload;

      log.info('Find payload ', JSON.stringify(payload));
      await this.flushCache();

      const lim = limit || 1000;
      const off = offset || 0;
      const ind = indexes || [];
      let result = null;

      if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object'
        && Array.isArray(ind)
        && (ind.length === 0
          || (ind.length > 0
            && ind.every(el => el.index && typeof el.index === 'string'
              && el.descending !== undefined && typeof el.descending === 'boolean')))
        && Number.isInteger(lim)
        && Number.isInteger(off)
        && lim > 0 && lim <= 1000
        && off >= 0) {
        const finalTableName = `${contract}_${table}`;
        const contractInDb = await this.findContract({ name: contract });
        let tableData = null;
        if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
          tableData = this.database.collection(finalTableName);
        }

        if (tableData) {
          const customPrimaryKey = contractInDb.tables[finalTableName].primaryKey;
          if (customPrimaryKey) {
            adjustQueryForPrimaryKey(query, customPrimaryKey);
          }

          // if there is an index passed, check if it exists
          if (ind.length > 0) {
            const tableIndexes = await indexInformation(tableData);

            const sort = [];
            if (ind.every(el => tableIndexes[`${el.index}_1`] !== undefined || el.index === '$loki' || el.index === '_id' || tableIndexes[el.index] !== undefined)) {
              ind.forEach((el) => {
                if (tableIndexes[el.index] !== undefined) {
                  tableIndexes[el.index].forEach((indexPart) => {
                    const indexField = indexPart[0];
                    const indexSort = indexPart[1];
                    if (el.descending === true) {
                      sort.push([indexField, indexSort === 1 ? 'desc' : 'asc']);
                    } else {
                      sort.push([indexField, indexSort === 1 ? 'asc' : 'desc']);
                    }
                  });
                } else {
                  sort.push([el.index === '$loki' ? '_id' : el.index, el.descending === true ? 'desc' : 'asc']);
                }
              });
            } else {
              // This can happen when creating a table and using find with index all in the same transaction
              // and should be rare in production. Otherwise, contract code is asking for an index that does
              // not exist.
              log.info(`Index ${JSON.stringify(ind)} not available for ${finalTableName}`); // eslint-disable-line no-console
            }
            if (sort.length === 0 || sort[sort.length - 1][0] !== '_id') {
                sort.push(['_id', 'asc']);
            }
            result = await tableData.find(EJSON.deserialize(query), {
              limit: lim,
              skip: off,
              sort,
              session: this.session,
            }).toArray();

            result = EJSON.serialize(result);
          } else {
            result = await tableData.find(EJSON.deserialize(query), {
              limit: lim,
              skip: off,
              session: this.session,
            }).toArray();
            result = EJSON.serialize(result);
          }
        }
      }

      return result;
    } catch (error) {
      // eslint-disable-next-line no-console
      log.error(error);
      return null;
    }
  }

  /**
   * retrieve a record from the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @returns {Object} returns a record if it exists, null otherwise
   */
  async findOne(payload) { // eslint-disable-line no-unused-vars
    try {
      const { contract, table, query } = payload;
      log.info('findOne payload ', payload);
      let result = null;
      if (contract && typeof contract === 'string'
        && table && typeof table === 'string'
        && query && typeof query === 'object') {
        if (query.$loki) {
          query._id = query.$loki; // eslint-disable-line no-underscore-dangle
          delete query.$loki;
        }
        const finalTableName = `${contract}_${table}`;
        const contractInDb = await this.findContract({ name: contract });
        let tableData = null;
        if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
          tableData = this.database.collection(finalTableName);
        }
        if (tableData) {
          const customPrimaryKey = contractInDb.tables[finalTableName].primaryKey;
          if (customPrimaryKey) {
            adjustQueryForPrimaryKey(query, customPrimaryKey);
          }

          if (this.session) {
            const cacheKey = objectCacheKey(contract, table, query);
            if (cacheKey) {
              if (this.objectCache[cacheKey]) {
                return this.objectCache[cacheKey];
              }
            } else {
              await this.flushCache();
            }
          }

          result = await tableData.findOne(EJSON.deserialize(query), { session: this.session });
          if (result) {
            result = EJSON.serialize(result);
          }
        }
      }

      return result;
    } catch (error) {
      // eslint-disable-next-line no-console
      log.error(error);
      return null;
    }
  }

  /**
   * insert a record in the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {String} record record to save in the table
   */
  async insert(payload) { // eslint-disable-line no-unused-vars
    const { contract, table, record } = payload;
    const finalTableName = `${contract}_${table}`;
    let finalRecord = null;

    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = this.database.collection(finalTableName);
      if (tableInDb) {
        finalRecord = EJSON.deserialize(record);
        const customPrimaryKey = contractInDb.tables[finalTableName].primaryKey;
        if (customPrimaryKey) {
          finalRecord._id = {}; // eslint-disable-line no-underscore-dangle
          customPrimaryKey.forEach((k) => {
            finalRecord._id[k] = finalRecord[k]; // eslint-disable-line no-underscore-dangle
          });
        } else {
          finalRecord._id = await this.getNextSequence(finalTableName); // eslint-disable-line
        }
        await tableInDb.insertOne(finalRecord, { session: this.session });
        await this.updateTableHash(contract, finalTableName);
      }
    }

    return finalRecord;
  }

  /**
   * remove a record in the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {String} record record to remove from the table
   */
  async remove(payload) { // eslint-disable-line no-unused-vars
    const { contract, table, record } = payload;
    const finalTableName = `${contract}_${table}`;

    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = this.database.collection(finalTableName);
      if (tableInDb) {
        await this.updateTableHash(contract, finalTableName);
        await tableInDb.deleteOne({ _id: record._id }, { session: this.session }); // eslint-disable-line no-underscore-dangle

        const cacheKey = objectCacheKey(contract, table, record);
        if (cacheKey && this.objectCache[cacheKey]) {
          delete this.objectCache[cacheKey];
        }
      }
    }
  }

  /**
   * update a record in the table of a contract
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {String} record record to update in the table
   * @param {String} unsets record fields to be removed (optional)
   */
  async update(payload, cache = true) {
    const {
      contract, table, record, unsets,
    } = payload;

    const finalTableName = `${contract}_${table}`;

    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = this.database.collection(finalTableName);
      if (tableInDb) {
        if (unsets && !cache) {
          await this.flushCache();
        } else if (cache) {
          const cacheKey = objectCacheKey(contract, table, record);
          if (cacheKey) {
            this.objectCache[cacheKey] = record;
            await this.updateTableHash(contract, finalTableName);
            return;
          }
        }

        if (cache) {
          // Do not re-update table hash when flushing cache.
          await this.updateTableHash(contract, finalTableName);
        }

        if (unsets) {
          await tableInDb.updateOne({ _id: record._id }, { $set: EJSON.deserialize(record), $unset: EJSON.deserialize(unsets) }, { upsert: true, session: this.session }); // eslint-disable-line
        } else {
          await tableInDb.updateOne({ _id: record._id }, { $set: EJSON.deserialize(record) }, { upsert: true, session: this.session }); // eslint-disable-line
        }
      }
    }
  }

  async flushCache() {
    if (!this.session) {
      return;
    }
    const keys = Object.keys(this.objectCache);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      const keyParts = k.split('_');
      const payload = {
        contract: keyParts[0],
        table: keyParts[1],
        record: this.objectCache[k],
      };
      await this.update(payload, false);
    }
    this.objectCache = {};
  }

  async flushContractCache() {
    if (!this.session) {
      return;
    }
    const contracts = this.database.collection('contracts');
    const keys = Object.keys(this.contractCache);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      await contracts.updateOne({ _id: k }, { $set: this.contractCache[k] }, { session: this.session });
    }
    this.contractCache = {};
  }

  /**
   * get the details of a smart contract table
   * @param {String} contract contract name
   * @param {String} table table name
   * @param {String} record record to update in the table
   * @returns {Object} returns the table details if it exists, null otherwise
   */
  async getTableDetails(payload) {
    const { contract, table } = payload;
    const finalTableName = `${contract}_${table}`;
    const contractInDb = await this.findContract({ name: contract });
    let tableDetails = null;
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = this.database.collection(finalTableName);
      if (tableInDb) {
        tableDetails = Object.assign({}, contractInDb.tables[finalTableName]);
        tableDetails.indexes = await tableInDb.indexInformation();
      }
    }

    return tableDetails;
  }

  /**
   * check if a table exists
   * @param {String} contract contract name
   * @param {String} table table name
   * @returns {Object} returns true if the table exists, false otherwise
   */
  async tableExists(payload) {
    const { contract, table } = payload;
    const finalTableName = `${contract}_${table}`;
    let result = false;
    const contractInDb = await this.findContract({ name: contract });
    if (contractInDb && contractInDb.tables[finalTableName] !== undefined) {
      const tableInDb = this.database.collection(finalTableName);
      if (tableInDb) {
        result = true;
      }
    }

    return result;
  }

  /**
   * retrieve records from the table
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @param {Integer} limit limit the number of records to retrieve
   * @param {Integer} offset offset applied to the records set
   * @param {Array<Object>} indexes array of index definitions { index: string, descending: boolean }
   * @returns {Array<Object>} returns an array of objects if records found, an empty array otherwise
   */
  async dfind(payload, callback) { // eslint-disable-line no-unused-vars
    const {
      table,
      query,
      limit,
      offset,
      indexes,
    } = payload;
    await this.flushCache();

    const lim = limit || 1000;
    const off = offset || 0;
    const ind = indexes || [];

    const tableInDb = await this.getCollection(table);
    let records = [];

    if (tableInDb) {
      if (ind.length > 0) {
        records = await tableInDb.find(EJSON.deserialize(query), {
          limit: lim,
          skip: off,
          sort: ind.map(el => [el.index === '$loki' ? '_id' : el.index, el.descending === true ? 'desc' : 'asc']),
          session: this.session,
        });
        records = EJSON.serialize(records);
      } else {
        records = await tableInDb.find(EJSON.deserialize(query), {
          limit: lim,
          skip: off,
          session: this.session,
        });
        records = EJSON.serialize(records);
      }
    }

    return records;
  }

  /**
   * retrieve a record from the table
   * @param {String} table table name
   * @param {JSON} query query to perform on the table
   * @returns {Object} returns a record if it exists, null otherwise
   */
  async dfindOne(payload) {
    const { table, query } = payload;
    await this.flushCache();

    const tableInDb = await this.getCollection(table);
    let record = null;

    if (query.$loki) {
      query._id = query.$loki; // eslint-disable-line no-underscore-dangle
      delete query.$loki;
    }

    if (tableInDb) {
      record = await tableInDb.findOne(EJSON.deserialize(query), { session: this.session });
      record = EJSON.serialize(record);
    }

    return record;
  }

  /**
   * insert a record
   * @param {String} table table name
   * @param {String} record record to save in the table
   */
  async dinsert(payload) {
    const { table, record } = payload;
    const tableInDb = this.database.collection(table);
    const finalRecord = record;
    finalRecord._id = await this.getNextSequence(table); // eslint-disable-line
    await tableInDb.insertOne(EJSON.deserialize(finalRecord), { session: this.session });
    await this.updateTableHash(table.split('_')[0], table.split('_')[1]);

    return finalRecord;
  }

  /**
   * update a record in the table
   * @param {String} table table name
   * @param {String} record record to update in the table
   */
  async dupdate(payload) {
    const { table, record } = payload;

    const tableInDb = this.database.collection(table);
    await this.updateTableHash(table.split('_')[0], table.split('_')[1]);
    await tableInDb.updateOne(
      { _id: record._id }, // eslint-disable-line no-underscore-dangle
      { $set: EJSON.deserialize(record) }, { session: this.session },
    );
  }

  /**
   * remove a record
   * @param {String} table table name
   * @param {String} record record to remove from the table
   */
  async dremove(payload) { // eslint-disable-line no-unused-vars
    const { table, record } = payload;

    const tableInDb = this.database.collection(table);
    await this.updateTableHash(table.split('_')[0], table.split('_')[1]);
    await tableInDb.deleteOne({ _id: record._id }, { session: this.session }); // eslint-disable-line no-underscore-dangle
  }
}

module.exports.Database = Database;
