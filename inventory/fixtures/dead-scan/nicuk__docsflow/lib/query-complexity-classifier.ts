// Excerpt of nicuk/docsflow, lib/query-complexity-classifier.ts, seen in P5.
export const queryClassifier = {
  classify: (message: string) => ({ complexity: message.length > 200 ? 'complex' : 'simple' }),
};
