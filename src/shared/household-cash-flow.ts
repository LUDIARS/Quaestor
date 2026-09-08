export interface CashFlowPeriod {
  income: number;
  household: number;
  business: number;
  outflow: number;
  balance: number;
  savings_rate: number | null;
  income_count: number;
}

export interface HouseholdCashFlow {
  current: CashFlowPeriod;
  previous: CashFlowPeriod;
  trend: "improving" | "declining" | "stable" | "insufficient_data";
  reasons: string[];
  savings_rate_delta: number | null;
  monthly: (CashFlowPeriod & { month: string; is_partial: boolean })[];
}

export interface SavingSuggestion {
  category_id: number;
  name: string;
  amount: number;
  count: number;
  action: string;
  scenario_saving: number;
  reduction_rate: number;
}
