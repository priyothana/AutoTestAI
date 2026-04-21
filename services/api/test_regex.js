const ragContext = `
=== WEB APPLICATION PAGE METADATA ===
  Submit Buttons (use for CLICK step after filling all fields):
    ⚡ BUTTON NAME: "Create Campaign"  →  Use this EXACT name as target for the CLICK step  (locator_type: "role")
`;
const btnMatch = ragContext.match(/⚡ BUTTON NAME:\s*"([^"]+)"/i);
console.log(btnMatch ? btnMatch[1] : 'NULL');

const prompt = "Create Aero campaign";
const STOP_WORDS = /^(a|an|new|record|test|the|this|my|it)$/i
const entityMatch = prompt.match(/(?:create|add|new)\s+(?:a\s+|an\s+|new\s+)?(\w+)/i)
let entityName = entityMatch ? entityMatch[1] : ''
if (!entityName || STOP_WORDS.test(entityName)) {
  const words = prompt.split(/\s+/)
  const verbIdx = words.findIndex(w => /^(create|add|new)$/i.test(w))
  if (verbIdx >= 0) {
    for (let wi = verbIdx + 1; wi < words.length; wi++) {
      const w = words[wi].replace(/[^a-zA-Z]/g, '')
      if (w && !STOP_WORDS.test(w)) { entityName = w; break }
    }
  }
}
if (!entityName) entityName = 'Record'
console.log("Entity:", entityName)
