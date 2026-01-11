const sql = require('mssql');

const DEFAULT_CONN = process.env.MSSQL_CONN || 'mssql://lprw:nFRq7u3CJNXV9eMw@SQLCL02.nsam.epglobal.org:1433/LabProducts';

let pool;

async function getPool() {
  if (pool && pool.connected) return pool;
  const config = parseConnectionString(DEFAULT_CONN);
  pool = await new sql.ConnectionPool(config).connect();
  return pool;
}

function parseConnectionString(conn) {
  // accept 'mssql://user:pass@host:port/database'
  try {
    if (conn.startsWith('mssql://')) {
      const u = new URL(conn);
      return {
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        server: u.hostname,
        port: parseInt(u.port, 10) || 1433,
        database: u.pathname.replace(/^\//, ''),
        options: { encrypt: false, enableArithAbort: true }
      };
    }
  } catch (e) {}
  // fallback: let mssql package handle it
  return conn;
}

module.exports = { getPool, sql };
