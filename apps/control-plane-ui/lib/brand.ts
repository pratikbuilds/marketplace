function envWithDefault(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

export const SITE_NAME = envWithDefault(
  process.env.NEXT_PUBLIC_SITE_NAME,
  "Faremeter Marketplace",
);
export const DOCS_URL = envWithDefault(
  process.env.NEXT_PUBLIC_DOCS_URL,
  "https://docs.faremeter.xyz",
);
export const SALES_EMAIL = envWithDefault(
  process.env.NEXT_PUBLIC_SALES_EMAIL,
  "sales@faremeter.xyz",
);
export const SUPPORT_URL = process.env.NEXT_PUBLIC_SUPPORT_URL ?? "";
