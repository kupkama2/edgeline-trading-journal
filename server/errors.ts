/**
 * An error as it may be written to a log. A failed query's message carries
 * the SQL and every parameter — on an account-settings write that is the
 * API key and the sealed secret — so the parameters are cut off.
 */
export function loggableError(err: any): string {
  const msg = String(err?.message ?? err);
  const cut = msg.split(/\bparams:/i)[0].trim();
  const cause = err?.cause?.message ? ` (cause: ${String(err.cause.message).split(/\bparams:/i)[0].trim()})` : "";
  const code = err?.cause?.code ?? err?.code;
  return `${cut}${cause}${code ? ` [${code}]` : ""}`;
}
