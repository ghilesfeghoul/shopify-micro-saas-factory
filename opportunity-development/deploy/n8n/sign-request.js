// ╔══════════════════════════════════════════════════════════════════╗
// ║  n8n CODE NODE — Sign request for Opportunity Development API   ║
// ║                                                                   ║
// ║  Required n8n env vars:                                          ║
// ║  - DEVELOPMENT_HMAC_SECRET                                       ║
// ║  - DEVELOPMENT_URL                                               ║
// ╚══════════════════════════════════════════════════════════════════╝

const crypto = require('crypto');

const HMAC_SECRET = $env.DEVELOPMENT_HMAC_SECRET;
const METHOD = 'POST';
const PATH = '/develop/generate';

const body = {
  specId: 'SPEC-XXXX',  // replace via earlier nodes in your workflow
  async: true,           // recommended for n8n — generation takes 20-40 min
};
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
