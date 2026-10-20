const bizSdk = require('facebook-nodejs-business-sdk');
const { Campaign, AdSet } = require('facebook-nodejs-business-sdk');

const AdAccount = bizSdk.AdAccount;

async function campaigns(accountId, token) {
  bizSdk.FacebookAdsApi.init(token);
  const account = new AdAccount(accountId);
  const list = await account.getCampaigns([Campaign.Fields.name, 'status'], { limit: 10 });
  await account.createCampaign([], {
    [Campaign.Fields.name]: 'Spring',
    [Campaign.Fields.objective]: 'OUTCOME_TRAFFIC',
  });
  await new Campaign(list[0].id).getAdSets([AdSet.Fields.daily_budget]);
  return new AdSet('1').get(process.env.FIELDS.split(','));
}

module.exports = { campaigns };
