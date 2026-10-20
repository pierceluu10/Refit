import { expect, it } from 'vitest';

it('builds the accounts URL', () => {
  expect(fetch).toHaveBeenCalledWith('https://graph.facebook.com/v19.0/me/accounts');
});
