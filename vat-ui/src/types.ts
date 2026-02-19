export type VatRow = {
  input?: string;
  source?: string;
  state?: string; // valid/invalid/queued/retry/processing/error
  vat_number?: string;
  country_code?: string;
  vat_part?: string;
  valid?: boolean | null;
  name?: string;
  address?: string;
  error?: string;
  details?: string;
};

export type ValidateBatchResponse = {
  count: number;
  fr_job_id?: string | null;
  results: VatRow[];
};

export type FrJobResponse = {
  job: {
    job_id: string;
    status: string; // running/completed/queued
    total: number;
    done: number;
    updated_at: number;
    created_at: number;
    message?: string | null;
  };
  results: VatRow[];
};
