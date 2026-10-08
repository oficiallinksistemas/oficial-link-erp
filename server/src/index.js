'use strict';

/** Entrypoint de produção — sobe o servidor na porta configurada. */

const config = require('./config');
const app = require('./app');

app.listen(config.port, () => {
  console.log('');
  console.log('  Oficial Link ERP');
  console.log('  Oficial Link Sistemas — www.oficiallink.com');
  console.log('  ------------------------------------------');
  console.log(`  Banco de dados: ${config.dbFile}`);
  console.log(`  Servidor em execução: http://localhost:${config.port}`);
  console.log('');
});
