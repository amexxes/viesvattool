export type ResultState = "valid" | "invalid" | "error" | "queued" | "retry" | "processing" | "running" | "completed";

export type ValidationRow = {
  input: string;
  source: string;
  state: string;
  vat_number: string;
  country_code: string;
  vat_part: string;
  valid: boolean | null;
  name: string;
  address: string;
  request_date: string;
  request_identifier: string;
  error: string;
  details: string;
};

export type ValidateBatchResponse = {
  count: number;
  fr_job_id: string | null;
  results: ValidationRow[];
};

export type FrJob = {
  job_id: string;
  created_at: number;
  updated_at: number;
  status: string;
  total: number;
  done: number;
  message: string | null;
};

export type FrJobResponse = {
  job: FrJob;
  results: ValidationRow[];
};
