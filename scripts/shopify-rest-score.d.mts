// Types for the plain-JavaScript scorer, so pipeline tests can import it under strict TypeScript.

export interface ShopifyRestUnitScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  errors: { kind: string; key: string }[];
}

export function scoreShopifyRest(
  labels: {
    repos: { repo: string }[];
    sites: { repo: string; file: string; line: number; rest: boolean; removed: boolean | null }[];
  },
  results: {
    results: {
      repo: string;
      status: string;
      rest: { file: string; line: number; use: string }[];
      calls: { file: string; line: number; use: string }[];
    }[];
  },
): {
  repositories: number;
  notScanned: string[];
  rest: ShopifyRestUnitScore;
  removed: ShopifyRestUnitScore;
};
