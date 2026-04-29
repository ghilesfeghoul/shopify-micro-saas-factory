// ╔══════════════════════════════════════════════════════════════════╗
// ║  n8n CODE NODE — Sign request for Opportunity Architecture API   ║
// ║                                                                   ║
// ║  Place BEFORE the HTTP Request node.                             ║
// ║  HTTP Request reads {{$json.headers}} and {{$json.body}}         ║
// ║                                                                   ║
// ║  Required n8n env vars:                                          ║
// ║  - ARCHITECT_HMAC_SECRET                                         ║
// ║  - ARCHITECT_URL                                                 ║
// ╚══════════════════════════════════════════════════════════════════╝

const crypto = require('crypto');

const HMAC_SECRET = $env.ARCHITECT_HMAC_SECRET;
const METHOD = 'POST';
const PATH = '/architect/poll'; // change to '/architect/generate' if needed

const body = {}; // for /architect/poll, no body. For /architect/generate use { opportunityId: 'OPP-XXXX' }
const bodyString = JSON.stringify(body);

const timestamp = Date.now().toString();
const nonce = crypto.randomBytes(16).toString('hex');

const bodyHash = crypto.createHmac('sha256', '').update(bodyString).digest('hex');
const signingString = `${METHOD}\n${PATH}\n${timestamp}\n${nonce}\n${bodyHash}`;
const signature = crypto.createHmac('sha256', HMAC_SECRET).update(signingString).digest('hex');

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
