// Excerpt of bricefrisco/NamesLoL at c997bdd9419f, src/libs/mapper.ts, seen in P5.
export const mapSummoner = (summoner: RiotResponse, r: Region): SummonerEntity => {
  return {
    name: summoner.name,
    summonerIcon: summoner.profileIconId,
    availabilityDate: calcAvailabilityDate(summoner.revisionDate, summoner.summonerLevel),
    lastUpdated: new Date().valueOf(),
    region: r,
    level: summoner.summonerLevel,
    revisionDate: summoner.revisionDate,
    accountId: summoner.accountId
  };
};

