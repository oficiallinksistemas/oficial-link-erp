
'use strict';
// Stub proposital do iconv-lite para o Cloudflare Workers:
// o ERP opera 100% em UTF-8 (JSON), entao a conversao de charsets
// exoticos nunca e necessaria. Evita a regressao do bundler
// (workers-sdk#9309: require_streams nao e funcao no iconv-lite real).
function decode(buffer) {
  return Buffer.from(buffer).toString('utf8');
}
function encode(string) {
  return Buffer.from(String(string), 'utf8');
}
module.exports = {
  decode,
  encode,
  encodingExists: () => true,
  defaultCharUnicode: '\uFFFD',
  defaultCharSingleByte: '?',
};
