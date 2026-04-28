// ╔══════════════════════════════════════════════════════════════════╗
// ║  n8n CODE NODE — Sign request for Opportunity Detector API       ║
// ║                                                                   ║
// ║  Place this BEFORE the HTTP Request node.                        ║
// ║  The HTTP Request node reads {{$json.headers}} and {{$json.body}}║
// ╚══════════════════════════════════════════════════════════════════╝

const crypto = require('crypto');

// ─── Configuration (from n8n credentials) ─────────────────────────
// Store HMAC_SECRET in n8n credentials, never inline in workflow!
const HMAC_SECRET = $env.DETECTOR_HMAC_SECRET;
const METHOD = 'POST';
const PATH = '/scan';

// ─── Build payload ────────────────────────────────────────────────
const body = {
  source: 'all',
  minScore: 30,
  maxOpportunities: 10,
};
const bodyString = JSON.stringify(body);

// ─── Generate signature ───────────────────────────────────────────
const timestamp = Date.now().toString();
const nonce = crypto.randomBytes(16).toString('hex');

const bodyHash = crypto.createHmac('sha256', '').update(bodyString).digest('hex');
const signingString = `${METHOD}\n${PATH}\n${timestamp}\n${nonce}\n${bodyHash}`;
const signature = crypto.createHmac('sha256', HMAC_SECRET).update(signingString).digest('hex');

// ─── Output for HTTP Request node ─────────────────────────────────
return [{
  json: {
    body,
    headers: {
      'Content-Type': 'application/json',
      'x-signature-timestamp': timestamp,
      'x-signature-nonce': nonce,
      'x-signature': signature,
    },
  },
}];
