actions.createSSC = async () => {
  const tableExists = await api.db.tableExists('pendingAirdrops');
  if (tableExists === false) {
    await api.db.createTable('pendingAirdrops', ['txId', 'symbol', 'sender']);
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