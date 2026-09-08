/** Contract for the household spending comparison returned by the analysis API. */
export interface HouseholdEvaluation {
  status: "increased" | "decreased" | "stable" | "insufficient_data";
  reasons: string[];
  current_daily: number;
  previous_daily: number;
  change_rate: number | null;
  threshold: number;
  drivers: { category_id: number; name: string; daily_delta: number }[];
}
