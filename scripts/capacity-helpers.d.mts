export interface TimeUsage {
  userSeconds: number;
  systemSeconds: number;
  maxRssBytes: number;
}
export function parseTime(text: string): TimeUsage | null;
export interface Distribution {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}
export function distribution(values: number[]): Distribution | null;
