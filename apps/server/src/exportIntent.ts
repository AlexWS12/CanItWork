// Whether a chat message asks for the design as a file: "export this as SQL", "give me the compose file", "download the
// schema". Settled by code, so a plain request costs no model call. Phrased so that a part named "export" in the system
// ("kill the export service", "what if the export queue fills up") is not mistaken for one.

const FORMAT = /\b(sql|ddl|postgres(?:ql)?|docker[- ]?compose|compose|ya?ml|schema file|\.sql|\.ya?ml)\b/i;
const THING = /\b(this|it|that|the (design|schema|system|database|db|stack|setup|app|file|whole thing)|my (design|schema|system|database|stack))\b/i;

// A format word naming a part of the system ("the compose service", "the sql server") rather than a file
const COMPONENT = /\b(sql|ddl|compose|ya?ml|postgres(?:ql)?)\s+(service|server|worker|queue|db|database|instance|node|cluster|replica)s?\b/;

export function asksForExport(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text || text.length > 300) return false;
  // "export", "download" or "save as" at the start, or aimed at the design: "export this", "download the schema"
  if (/^(please\s+|can you\s+|could you\s+|now\s+)?(export|download)\b(?!\s+(service|queue|job|worker|api|module|server|pipeline)s?\b)/.test(text)) return true;
  if (/\b(export|download|save)\b/.test(text) && THING.test(text) && !/\b(service|queue|worker|job|pipeline)s?\b/.test(text.replace(THING, ''))) return true;
  // Asking for the file in a format: "give me the SQL", "I want a docker compose file", "send me the yaml"
  // Only a request phrased as one: "give me", "send me", "I want/need", "generate/make/write a/the", "get me"
  const request = /\b(give|send|get)\s+(me|us)\b|\b(i|we)\s+(want|need|would like)\b|\b(generate|make|write)\s+(me\s+)?(a|an|the)\b/;
  if (
    request.test(text) &&
    /\b(file|sql|ddl|compose|ya?ml)\b/.test(text) &&
    FORMAT.test(text) &&
    !/\b(quer(y|ies)|errors?|slow(er)?|fast(er)?)\b/.test(text) &&
    !COMPONENT.test(text)
  )
    return true;
  if (/\b(as|into|in|to)\s+(an?\s+)?(sql|ddl|docker[- ]?compose|compose|ya?ml)(\s+file)?\b/.test(text) && /\b(export|download|save|turn|convert|get|give|want|need)\b/.test(text))
    return true;
  return false;
}
