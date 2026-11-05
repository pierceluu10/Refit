// Excerpt of b1f6c1c4/c at 6f925cdd277d, src/api/monday.js, seen in P5.
const got = require('got');
const config = require('../config').monday;

const api = got.extend({
  method: 'POST',
  url: 'https://api.monday.com/v2',
  headers: { authorization: config.apiKey },
  responseType: 'json',
});
module.exports = {
  find: async (column, value, fields = fullFields, limit = 0) => {
    const data = await run(`query find($bId: Int!, $cId: String!, $value: String!, $cIds: [String]) {
      items_by_column_values(board_id: $bId, column_id: $cId, column_value: $value${limit ? ', limit: ' + limit : ''}) {
        id
        name
        column_values(ids: $cIds) { id text }
      }
    }`, { cId: config.cIds[column], value, ...preProcess(fields) });
    return postProcess(data.items_by_column_values);
  },
  findAll: async (fields = fullFields, limit = 0) => {
    const data = await run(`query findAll($bId: [Int], $cIds: [String]) {
      boards(ids: $bId) {
        items${limit ? '(limit: ' + limit + ')' : ''} {
          id
          name
          column_values(ids: $cIds) { id text }
        }
      }
    }`, preProcess(fields));
    return postProcess(data.boards[0].items);
  },
