/* eslint-disable no-await-in-loop */
/* eslint-disable quote-props */
/* global actions, api */

actions.createSSC = async () => {
  await api.db.createTable('test');

  await api.db.insert('test', { a: 1 });
  api.assert(false, 'Error condition');
};
