// What Meta's WhatsApp Cloud API error codes mean, for the logs: the meaning Meta documents for each code
// (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes), worded for whoever reads the log.
// Only codes listed here get an explanation; any other code is logged with Meta's own title and details and is
// never interpreted, so a reason is never guessed.
export const META_ERRORS: Record<number, string> = {
  0: "Meta couldn't authenticate the app (AuthException): the access token is invalid or expired",
  1: 'Meta reported an unknown error on its side (API Unknown); it may be temporary',
  2: 'Meta reported a temporary service error (API Service)',
  3: "The app isn't allowed this API call (API Method): a missing permission or capability",
  4: 'Too many API calls from this app (rate limit); wait before retrying',
  10: "Permission denied: the access token doesn't have the needed permission",
  100: 'Meta rejected a parameter of the request (Invalid parameter)',
  190: 'The access token has expired or was revoked',
  368: 'The WhatsApp Business account is temporarily blocked for policy violations',
  80007: 'The WhatsApp Business account hit its rate limit',
  130429: "The number's message throughput limit was hit (Cloud API rate limit)",
  130472: "The customer's number is part of a Meta experiment and this message wasn't sent",
  131000: 'Meta failed to send the message for an unknown reason (Something went wrong)',
  131005: "Access denied: the access token doesn't have permission for this number",
  131008: 'A required parameter is missing from the request',
  131009: 'A parameter value is not valid',
  131016: 'The WhatsApp service is temporarily unavailable',
  131021: 'The recipient is the same number as the sender',
  131026: "Message undeliverable: the customer's number can't receive it (Meta lists: not a WhatsApp user, an old WhatsApp version, or new Terms of Service not accepted)",
  131031: 'The WhatsApp Business account is locked',
  131042: 'A payment problem on the WhatsApp Business account (Business eligibility payment issue)',
  131045: 'The phone number is not registered (Incorrect certificate)',
  131047: 'More than 24 hours since the customer last wrote: only an approved template can be sent (Re-engagement message)',
  131048: 'The number is limited because too many of its messages were blocked or reported as spam (Spam rate limit hit)',
  131049: 'Meta chose not to deliver this message to maintain healthy ecosystem engagement (per-customer marketing limit); retrying right away will fail again',
  131050: 'The customer stopped marketing messages from this business',
  131051: 'Unsupported message type',
  131052: "Meta couldn't download the media the customer sent (Media download error)",
  131053: "Meta couldn't use the uploaded media (Media upload error): unsupported type or file",
  131056: 'Too many messages from this business to the same customer in a short time (pair rate limit)',
  131057: 'The WhatsApp Business account is in maintenance mode',
  132000: "The number of template values doesn't match the template's placeholders",
  132001: "The template doesn't exist in that language, or isn't approved",
  132005: 'The template text with its values is too long',
  132007: "The template's content breaks WhatsApp's formatting policy",
  132012: "A template value doesn't have the format the template expects",
  132015: 'The template is paused (low quality)',
  132016: 'The template is disabled (low quality)',
  133010: 'The phone number is not registered on the WhatsApp Business Platform',
  135000: 'Meta reported a generic user error',
};

export function explainMetaError(code: number | string | null | undefined): string | null {
  if (code === null || code === undefined || code === '') return null;
  const n = Number(code);
  return Number.isInteger(n) ? (META_ERRORS[n] ?? null) : null;
}
