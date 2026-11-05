// Excerpt of b1f6c1c4/c at 6f925cdd277d, src/api/recipe.js, seen in P5.
const got = require('got');
const Chance = require('chance');
const { decode } = require('html-entities');

const api = got.extend({
  method: 'GET',
  url: 'http://www.recipepuppy.com/api',
  responseType: 'json',
});
